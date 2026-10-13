// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { DtoEventType, IDtoEventSubscriber, IDtoPayload } from '..';
import createPostgresSubscriber, { Subscriber } from 'pg-listen';
import { ILogObj, Logger } from 'tslog';
import { OcpiConfig, OcpiConfigToken } from '../../config/ocpi.types';
import { Inject, Service } from 'typedi';

interface IPgNotification {
  operation: DtoEventType;
  data: any;
}

type EventHandler<T = any> = {
  handleEvent: (event: { eventType: DtoEventType; payload: T }) => void;
  handleError: (error: any) => void;
  handleDisconnect?: () => void;
};

/** Health check (`SELECT pg_backend_pid()`) interval on the LISTEN connection. */
const PARANOID_CHECK_INTERVAL_MS = 30_000;
/** A query (health check or LISTEN) on a half-open socket fails after this. */
const QUERY_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const TCP_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
const RETRY_MAX_INTERVAL_MS = 30_000;

/** 1 s, 2 s, 4 s, ... capped at 30 s. `failedAttempts` starts at 0. */
const retryBackoff = (failedAttempts: number): number =>
  Math.min(RETRY_MAX_INTERVAL_MS, 1000 * 2 ** failedAttempts);

/**
 * Receives Postgres NOTIFY events on one dedicated LISTEN connection.
 *
 * The connection is managed by pg-listen: a periodic health check catches a
 * socket that died without an `error`/`end` event, reconnects retry forever
 * with backoff, and every subscribed channel is LISTENed again after a
 * reconnect. Notifications sent while the connection was down are lost;
 * `onConnected` listeners run after every (re)connect so they can catch up.
 */
@Service()
export class PgNotifyEventSubscriber implements IDtoEventSubscriber {
  protected readonly _listener: Subscriber;
  protected readonly _logger: Logger<ILogObj>;
  protected eventHandlers = new Map<string, EventHandler>();
  protected connectedListeners: Array<() => unknown> = [];
  protected connected = false;
  protected hasConnected = false;

  constructor(
    @Inject(OcpiConfigToken) config: OcpiConfig,
    logger?: Logger<ILogObj>,
  ) {
    this._logger = logger
      ? logger.getSubLogger({ name: this.constructor.name })
      : new Logger<ILogObj>({ name: this.constructor.name });

    this._listener = createPostgresSubscriber(
      {
        host: config.database.host,
        port: config.database.port,
        user: config.database.username,
        password: config.database.password,
        database: config.database.database,
        keepAlive: true,
        keepAliveInitialDelayMillis: TCP_KEEPALIVE_INITIAL_DELAY_MS,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS,
      },
      {
        paranoidChecking: PARANOID_CHECK_INTERVAL_MS,
        retryInterval: retryBackoff,
        // pg-listen gives up (and stops health checks for good) once either
        // limit is hit; 0 disables the timeout, so it never gives up.
        retryLimit: Infinity,
        retryTimeout: 0,
        // Parse per channel below so a bad payload reaches that channel's
        // handleError.
        parse: (payload: string) => payload,
      },
    );
  }

  async init(): Promise<void> {
    const events = this._listener.events;

    events.on('notification', ({ channel, payload }) => {
      const handler = this.eventHandlers.get(channel);
      if (!handler) return;

      try {
        const parsed: IPgNotification = JSON.parse(payload ?? '{}');
        handler.handleEvent({
          eventType: parsed.operation,
          payload: parsed.data,
        });
      } catch (err) {
        this._logger.error(`Failed to parse notification payload:`, err);
        handler.handleError(err);
      }
    });

    events.on('connected', () => {
      this.connected = true;
      if (this.hasConnected) {
        this._logger.info(
          `Reconnected to PostgreSQL for notifications; re-LISTENed on ${this._listener.getSubscribedChannels().length} channel(s)`,
        );
      } else {
        this.hasConnected = true;
        this._logger.info('Connected to PostgreSQL for notifications');
      }
      for (const listener of this.connectedListeners) {
        this.callConnectedListener(listener);
      }
    });

    events.on('reconnect', (attempt) => {
      if (this.connected) {
        this.connected = false;
        this._logger.warn(
          'Lost PostgreSQL notification connection; notifications are not received until it reconnects',
        );
        this.callDisconnectHandlers();
      }
      this._logger.warn(
        `PostgreSQL notification connection reconnect attempt #${attempt}`,
      );
    });

    // Without a listener, an 'error' event would throw and kill the process.
    events.on('error', (err) => {
      this._logger.error('PostgreSQL notification listener error:', err);
    });

    await this._listener.connect();
  }

  /**
   * Runs `listener` after every successful (re)connect, once all channels are
   * LISTENed. If already connected, it also runs right away.
   */
  onConnected(listener: () => unknown): void {
    this.connectedListeners.push(listener);
    if (this.connected) {
      this.callConnectedListener(listener);
    }
  }

  async subscribe<T extends IDtoPayload>(
    eventId: string,
    handleEvent: (event: { eventType: DtoEventType; payload: T }) => void,
    handleError: (error: any) => void,
    handleDisconnect?: () => void,
  ): Promise<boolean> {
    try {
      if (!this._listener.getSubscribedChannels().includes(eventId)) {
        await this._listener.listenTo(eventId);
        this._logger.info(`Subscribed to event channel "${eventId}"`);
      }

      this.eventHandlers.set(eventId, {
        handleEvent,
        handleError,
        handleDisconnect,
      });

      return true;
    } catch (error) {
      this._logger.error(`Failed to subscribe to "${eventId}":`, error);
      handleError(error);
      return false;
    }
  }

  async shutdown(): Promise<void> {
    try {
      this.eventHandlers.clear();
      this.connectedListeners = [];
      this.connected = false;
      await this._listener.close();
      this._logger.info('Postgres client closed');
    } catch (err) {
      this._logger.error('Error shutting down pg client:', err);
    }
  }

  private callConnectedListener(listener: () => unknown): void {
    try {
      Promise.resolve(listener()).catch((err) =>
        this._logger.error('Error in connected listener:', err),
      );
    } catch (err) {
      this._logger.error('Error in connected listener:', err);
    }
  }

  private callDisconnectHandlers(): void {
    const called = new Set<() => void>();
    for (const { handleDisconnect } of this.eventHandlers.values()) {
      if (handleDisconnect && !called.has(handleDisconnect)) {
        called.add(handleDisconnect);
        try {
          handleDisconnect();
        } catch (err) {
          this._logger.warn('Error in handleDisconnect callback:', err);
        }
      }
    }
  }
}
