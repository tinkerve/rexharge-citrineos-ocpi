// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// A fake `pg` driver: every Client the subscriber (or pg-listen inside it)
// creates is recorded, so a test can kill one connection and watch the
// subscriber come back on the next.
jest.mock('pg', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');
  class FakeClient extends EventEmitter {
    static instances: FakeClient[] = [];
    static failConnects = 0;
    static hangQueries = false;
    static failListens = 0;
    queries: string[] = [];
    constructor(readonly config: any) {
      super();
      FakeClient.instances.push(this);
    }
    async connect() {
      if (FakeClient.failConnects > 0) {
        FakeClient.failConnects--;
        throw new Error('ECONNREFUSED');
      }
      this.emit('connect');
    }
    query(sql: string) {
      this.queries.push(sql);
      if (sql.startsWith('LISTEN') && FakeClient.failListens > 0) {
        FakeClient.failListens--;
        return Promise.reject(new Error('LISTEN failed: connection reset'));
      }
      if (FakeClient.hangQueries) {
        // A half-open socket: the query never answers, so the real driver's
        // query_timeout is what rejects it.
        return new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Query read timeout')),
            this.config.query_timeout,
          ),
        );
      }
      return Promise.resolve({ rows: [] });
    }
    async end() {
      this.emit('end');
    }
    notify(channel: string, payload: unknown) {
      this.emit('notification', {
        processId: 1,
        channel,
        payload: JSON.stringify(payload),
      });
    }
  }
  return { Client: FakeClient };
});

import 'reflect-metadata';
import { Client } from 'pg';
import { ILogObj, Logger } from 'tslog';
import { DtoEventType } from '../types';
import { PgNotifyEventSubscriber } from './subscriber';

const FakeClient = Client as any;
const clients = (): any[] => FakeClient.instances;
const latest = () => clients()[clients().length - 1];

const config = {
  database: {
    host: 'db',
    port: 5432,
    username: 'u',
    password: 'p',
    database: 'citrine',
  },
} as any;

const flush = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
};

describe('PgNotifyEventSubscriber', () => {
  let subscriber: PgNotifyEventSubscriber;
  let logger: Logger<ILogObj>;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeClient.instances = [];
    FakeClient.failConnects = 0;
    FakeClient.hangQueries = false;
    FakeClient.failListens = 0;
    logger = new Logger<ILogObj>({ type: 'hidden' });
    subscriber = new PgNotifyEventSubscriber(config, logger);
  });

  afterEach(async () => {
    await subscriber.shutdown();
    jest.useRealTimers();
  });

  const subscribeChannel = async (channel: string) => {
    const events: any[] = [];
    const disconnects = jest.fn();
    await subscriber.subscribe(
      channel,
      (event) => events.push(event),
      () => undefined,
      disconnects,
    );
    return { events, disconnects };
  };

  it('delivers a notification sent after the connection is killed, without a restart', async () => {
    await subscriber.init();
    const { events, disconnects } = await subscribeChannel(
      'TransactionNotification',
    );
    const first = latest();
    expect(first.queries).toContain('LISTEN "TransactionNotification"');

    first.notify('TransactionNotification', {
      operation: 'UPDATE',
      data: { id: 1 },
    });
    expect(events).toEqual([
      { eventType: DtoEventType.UPDATE, payload: { id: 1 } },
    ]);

    // The server drops the connection.
    first.emit('end');
    await flush();

    const second = latest();
    expect(second).not.toBe(first);
    expect(second.queries).toContain('LISTEN "TransactionNotification"');
    expect(disconnects).toHaveBeenCalledTimes(1);

    second.notify('TransactionNotification', {
      operation: 'UPDATE',
      data: { id: 2 },
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      eventType: DtoEventType.UPDATE,
      payload: { id: 2 },
    });
  });

  it('notices a silently dead socket through the periodic health check', async () => {
    await subscriber.init();
    const { events } = await subscribeChannel('ConnectorNotification');
    const first = latest();
    expect(first.config).toMatchObject({ keepAlive: true });
    expect(first.config.query_timeout).toBeGreaterThan(0);

    // No error, no end: the health check query just never answers.
    FakeClient.hangQueries = true;
    await flush(30_000 + first.config.query_timeout);
    FakeClient.hangQueries = false;
    await flush();

    const second = latest();
    expect(second).not.toBe(first);
    expect(second.queries).toContain('LISTEN "ConnectorNotification"');

    second.notify('ConnectorNotification', { operation: 'UPDATE', data: {} });
    expect(events).toHaveLength(1);
  });

  it('keeps retrying with backoff for as long as the database stays down', async () => {
    await subscriber.init();
    const { events } = await subscribeChannel('ConnectorNotification');

    // Ten minutes of refused connections: far past pg-listen's 3 s default
    // give-up timeout.
    FakeClient.failConnects = 1_000_000;
    latest().emit('end');
    await flush(10 * 60_000);
    const attempts = clients().length - 1;
    // Backoff: nowhere near one attempt per 500 ms.
    expect(attempts).toBeGreaterThan(5);
    expect(attempts).toBeLessThan(100);

    FakeClient.failConnects = 0;
    await flush(60_000);

    const back = latest();
    expect(back.queries).toContain('LISTEN "ConnectorNotification"');
    back.notify('ConnectorNotification', { operation: 'UPDATE', data: {} });
    expect(events).toHaveLength(1);
  });

  it('tells connected listeners about the current connection and every reconnect', async () => {
    await subscriber.init();
    await subscribeChannel('ConnectorNotification');

    const connected = jest.fn();
    subscriber.onConnected(connected);
    await flush();
    expect(connected).toHaveBeenCalledTimes(1);

    latest().emit('end');
    await flush();
    expect(connected).toHaveBeenCalledTimes(2);
  });

  it('survives a listener that throws or rejects', async () => {
    await subscriber.init();
    subscriber.onConnected(() => {
      throw new Error('boom');
    });
    subscriber.onConnected(async () => {
      throw new Error('async boom');
    });
    await flush();

    latest().emit('error', new Error('socket hang up'));
    await flush();
    expect(clients()).toHaveLength(2);
  });

  it('logs connect, reconnect attempts and errors', async () => {
    const info = jest.spyOn(logger, 'info');
    const warn = jest.spyOn(logger, 'warn');
    const error = jest.spyOn(logger, 'error');
    // The subscriber logs through a sub-logger; capture that one.
    jest.spyOn(Logger.prototype, 'getSubLogger').mockReturnValue(logger);
    subscriber = new PgNotifyEventSubscriber(config, logger);

    await subscriber.init();
    expect(info.mock.calls.flat().join(' ')).toMatch(/connected/i);

    FakeClient.failConnects = 1;
    latest().emit('error', new Error('socket hang up'));
    await flush(60_000);

    const warnings = warn.mock.calls.flat().join(' ');
    expect(warnings).toMatch(/reconnect attempt #1/i);
    expect(warnings).toMatch(/reconnect attempt #2/i);
    expect(info.mock.calls.flat().join(' ')).toMatch(/reconnected/i);
    expect(error).not.toHaveBeenCalled();
  });

  it('recovers when re-LISTEN fails right after a reconnect', async () => {
    const error = jest.spyOn(logger, 'error');
    jest.spyOn(Logger.prototype, 'getSubLogger').mockReturnValue(logger);
    subscriber = new PgNotifyEventSubscriber(config, logger);
    await subscriber.init();
    const { events } = await subscribeChannel('ConnectorNotification');

    FakeClient.failListens = 1;
    latest().emit('end');
    await flush();
    expect(error.mock.calls.flat().join(' ')).toMatch(/LISTEN failed/);

    // The health check on the half-set-up connection trips another reconnect.
    latest().query = () => Promise.reject(new Error('connection reset'));
    await flush(30_000);
    await flush();

    const back = latest();
    expect(back.queries).toContain('LISTEN "ConnectorNotification"');
    back.notify('ConnectorNotification', { operation: 'UPDATE', data: {} });
    expect(events).toHaveLength(1);
  });
});
