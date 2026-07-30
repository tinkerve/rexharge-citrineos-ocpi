// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ILogObj, Logger } from 'tslog';
import { Inject, Service } from 'typedi';
import { OcpiConfig, OcpiConfigToken } from '../config/ocpi.types';
import { OcpiRequestLogPayload } from '../types/ocpi-request-log.types';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const SENSITIVE_KEYS = new Set([
  'apikey',
  'authorization',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'cookie',
  'idtoken',
  'privatekey',
  'proxyauthorization',
  'setcookie',
  'token',
  'accesstoken',
  'refreshtoken',
  'credential',
  'credentials',
  'password',
  'secret',
  'sharedsecret',
  'xapikey',
  'xaccesstoken',
  'xauthtoken',
  'xclientsecret',
  'xocpilogsecret',
  'xrefreshtoken',
]);
const URL_KEYS = new Set([
  'url',
  'uri',
  'endpoint',
  'contentlocation',
  'location',
  'referer',
  'referrer',
]);
const LINK_KEYS = new Set(['link']);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    (normalized.startsWith('x') && SENSITIVE_KEYS.has(normalized.slice(1)))
  );
}

function sanitizeUrl(value: string): string {
  try {
    const isRelative = value.startsWith('/');
    if (!isRelative && !/^https?:\/\//i.test(value)) return REDACTED;

    const url = new URL(value, 'http://internal.invalid');
    url.username = '';
    url.password = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (isSensitiveKey(key)) {
        url.searchParams.set(key, REDACTED);
      }
    }
    if (url.hash) {
      url.hash = url.hash.replace(
        /(^|[?&#])([^=&#]+)=([^&#]*)/g,
        (match, separator: string, rawKey: string) => {
          let key = rawKey;
          try {
            key = decodeURIComponent(rawKey);
          } catch {
            // Keep the undecoded key and fail closed if it is recognizable.
          }
          return isSensitiveKey(key)
            ? `${separator}${rawKey}=${REDACTED}`
            : match;
        },
      );
    }
    return url.origin === 'http://internal.invalid'
      ? `${url.pathname}${url.search}${url.hash}`
      : url.toString();
  } catch {
    return REDACTED;
  }
}

function sanitizeLinkHeader(value: string): string {
  return value.replace(/<([^>]*)>/g, (_match, rawUrl: string) => {
    return `<${sanitizeUrl(rawUrl)}>`;
  });
}

function sanitizeLeaf(value: unknown, key?: string): unknown {
  const normalizedKey = key ? normalizeKey(key) : undefined;
  if (key && isSensitiveKey(key)) return REDACTED;
  if (value instanceof Date) return value.toJSON();
  if (
    typeof value === 'string' &&
    normalizedKey &&
    LINK_KEYS.has(normalizedKey)
  ) {
    return sanitizeLinkHeader(value);
  }
  const isUrlKey =
    normalizedKey &&
    (URL_KEYS.has(normalizedKey) ||
      normalizedKey.endsWith('url') ||
      normalizedKey.endsWith('uri') ||
      normalizedKey.endsWith('endpoint'));
  if (typeof value === 'string' && isUrlKey) {
    return sanitizeUrl(value);
  }
  return value;
}

function sanitize(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;

  const root: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  const seen = new WeakSet<object>([value]);
  const pending: Array<{
    source: Record<string, unknown> | unknown[];
    target: Record<string, unknown> | unknown[];
    arrayItemKey?: string;
  }> = [
    {
      source: value as Record<string, unknown> | unknown[],
      target: root,
    },
  ];

  while (pending.length > 0) {
    const { source, target, arrayItemKey } = pending.pop()!;
    for (const [key, rawValue] of Object.entries(source)) {
      const effectiveKey = Array.isArray(source) ? arrayItemKey : key;
      const sanitized = sanitizeLeaf(rawValue, effectiveKey);
      if (sanitized !== rawValue || !rawValue || typeof rawValue !== 'object') {
        (target as any)[key] = sanitized;
        continue;
      }

      if (seen.has(rawValue)) {
        (target as any)[key] = CIRCULAR;
        continue;
      }
      seen.add(rawValue);

      const childTarget: Record<string, unknown> | unknown[] = Array.isArray(
        rawValue,
      )
        ? []
        : {};
      (target as any)[key] = childTarget;
      pending.push({
        source: rawValue as Record<string, unknown> | unknown[],
        target: childTarget,
        arrayItemKey: Array.isArray(rawValue) ? effectiveKey : undefined,
      });
    }
  }

  return root;
}

@Service()
export class OcpiRequestLogClient {
  constructor(
    @Inject(OcpiConfigToken) private readonly config: OcpiConfig,
    @Inject() private readonly logger: Logger<ILogObj>,
  ) {}

  get enabled(): boolean {
    return this.config.requestLog.enabled;
  }

  async send(payload: OcpiRequestLogPayload): Promise<void> {
    const { enabled, gatewayEndpoint, sharedSecret, timeoutMs } =
      this.config.requestLog;
    if (!enabled) return;

    if (!gatewayEndpoint || !sharedSecret) {
      this.logger.error(
        'OCPI request logging is enabled but Gateway endpoint or shared secret is missing.',
      );
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(gatewayEndpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          'x-ocpi-log-secret': sharedSecret,
        },
        body: JSON.stringify({ payload: sanitize(payload) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.error(
          `Gateway rejected OCPI request log with HTTP ${response.status}.`,
        );
      }
      await response.body?.cancel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to forward OCPI request log: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
