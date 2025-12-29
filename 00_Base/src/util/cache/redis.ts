// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ICache } from '@citrineos/base';
import { ClassConstructor, plainToInstance } from 'class-transformer';
import {
  createClient,
  RedisClientOptions,
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
} from 'redis';

/**
 * Implementation of cache interface with redis storage
 */
export class RedisCache implements ICache {
  private _client: RedisClientType<RedisModules, RedisFunctions, RedisScripts>;
  private _subscriber: RedisClientType<
    RedisModules,
    RedisFunctions,
    RedisScripts
  > | null = null;
  private _subscriberInitPromise: Promise<void> | null = null;

  constructor(clientOptions?: RedisClientOptions) {
    this._client = clientOptions ? createClient(clientOptions) : createClient();
    this._client.on('connect', () => console.log('Redis client connected'));
    this._client.on('ready', () => console.log('Redis client ready to use'));
    this._client.on('error', (err) => console.error('Redis error', err));
    this._client.on('end', () => console.log('Redis client disconnected'));
    this._client
      .connect()
      .then()
      .catch((error) => {
        console.log('Error connecting to Redis', error);
      });
  }

  /**
   * Lazy initialization of subscriber client
   */
  private async getSubscriber(): Promise<
    RedisClientType<RedisModules, RedisFunctions, RedisScripts>
  > {
    if (this._subscriber && this._subscriber.isOpen) {
      return this._subscriber;
    }

    // If already initializing, wait for that to complete
    if (this._subscriberInitPromise) {
      await this._subscriberInitPromise;
      return this._subscriber!;
    }

    // Initialize subscriber
    this._subscriberInitPromise = (async () => {
      try {
        this._subscriber = this._client.duplicate();
        this._subscriber.on('error', (err) =>
          console.error('Redis subscriber error', err),
        );
        await this._subscriber.connect();
        console.log('Redis subscriber connected');
      } catch (error) {
        console.error('Error initializing Redis subscriber', error);
        this._subscriber = null;
        throw error;
      } finally {
        this._subscriberInitPromise = null;
      }
    })();

    await this._subscriberInitPromise;
    return this._subscriber!;
  }

  exists(key: string, namespace?: string): Promise<boolean> {
    namespace = namespace || 'default';
    key = `${namespace}:${key}`;
    return this._client.exists(key).then((result) => result === 1);
  }

  remove(key: string, namespace?: string | undefined): Promise<boolean> {
    namespace = namespace || 'default';
    key = `${namespace}:${key}`;
    return this._client.del(key).then((result) => result === 1);
  }

  onChange<T>(
    key: string,
    waitSeconds: number,
    namespace?: string | undefined,
    classConstructor?: (() => ClassConstructor<T>) | undefined,
  ): Promise<T | null> {
    namespace = namespace || 'default';
    key = `${namespace}:${key}`;

    return new Promise((resolve) => {
      let isResolved = false;
      let timeoutId: NodeJS.Timeout;
      const channel = `__keyspace@0__:${key}`;

      const cleanup = () => {
        if (isResolved) return;
        isResolved = true;

        if (timeoutId) {
          clearTimeout(timeoutId);
        }

        // Unsubscribe from this specific channel
        this.getSubscriber()
          .then((subscriber) => subscriber.unsubscribe(channel))
          .catch((error) => {
            console.log('Error unsubscribing from channel', error);
          });
      };

      const messageHandler = async (message: string) => {
        if (isResolved) return;

        switch (message) {
          case 'set':
            try {
              const value = await this.get(key, namespace, classConstructor);
              resolve(value);
              cleanup();
            } catch (error) {
              console.log('Error getting value on set event', error);
            }
            break;

          case 'del':
          case 'expire':
            resolve(null);
            cleanup();
            break;

          default:
            // Do nothing for other events
            break;
        }
      };

      const initialize = async () => {
        try {
          const subscriber = await this.getSubscriber();

          // Subscribe to keyspace notifications
          await subscriber.subscribe(channel, messageHandler);

          // Set timeout as fallback
          timeoutId = setTimeout(async () => {
            if (isResolved) return;

            try {
              const value = await this.get(key, namespace, classConstructor);
              resolve(value);
              cleanup();
            } catch (error) {
              console.log('Error getting value on timeout', error);
              resolve(null);
              cleanup();
            }
          }, waitSeconds * 1000);
        } catch (error) {
          console.log('Error setting up Redis subscription', error);
          resolve(null);
          cleanup();
        }
      };

      initialize();
    });
  }

  get<T>(
    key: string,
    namespace?: string,
    classConstructor?: () => ClassConstructor<T>,
  ): Promise<T | null> {
    namespace = namespace || 'default';
    key = `${namespace}:${key}`;
    return this._client.get(key).then((result) => {
      if (result) {
        if (classConstructor) {
          return plainToInstance(classConstructor(), JSON.parse(result));
        }
        return result as T;
      }
      return null;
    });
  }

  set(
    key: string,
    value: string,
    namespace?: string,
    expireSeconds?: number,
  ): Promise<boolean> {
    namespace = namespace || 'default';
    key = `${namespace}:${key}`;
    const setOptions = expireSeconds ? { EX: expireSeconds } : undefined;
    return this._client.set(key, value, setOptions).then((result) => {
      if (result) {
        return result === 'OK';
      }
      return false;
    });
  }

  setIfNotExist(
    key: string,
    value: string,
    namespace?: string,
    expireSeconds?: number,
  ): Promise<boolean> {
    namespace = namespace || 'default';
    key = `${namespace}:${key}`;
    return this._client
      .set(
        key,
        value,
        expireSeconds ? { EX: expireSeconds, NX: true } : { NX: true },
      )
      .then((result) => {
        if (result) {
          return result === 'OK';
        }
        return false;
      });
  }

  /**
   * Cleanup method to close connections gracefully
   */
  async close(): Promise<void> {
    try {
      if (this._subscriber && this._subscriber.isOpen) {
        await this._subscriber.quit();
        console.log('Redis subscriber disconnected');
      }
      await this._client.quit();
      console.log('Redis client disconnected');
    } catch (error) {
      console.error('Error closing Redis connections', error);
    }
  }
}
