// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ILogObj, Logger } from 'tslog';
import { Inject, Service } from 'typedi';
import { OcpiConfig, OcpiConfigToken } from '../config/ocpi.types';
import { OcpiRequestLogPayload } from '../types/ocpi-request-log.types';

const REDACTED = '[REDACTED]';
// Keep 00_Base/src/test-fixtures/ocpi-log-sanitizer.v1.json in sync with the
// Gateway fixture at test/fixtures/ocpi-log-sanitizer.v1.json.
const CIRCULAR = '[Circular]';
const BINARY = '[Binary]';
const STREAM = '[Stream]';
export const OCPI_REQUEST_LOG_BODY_LIMIT_BYTES = 256 * 1024;
const FAILURE_LOG_INTERVAL_MS = 60_000;
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
    if (!isRelative && !/^https?:\/\//i.test(value)) return value;

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

function redactCredentialValues(value: string): string {
  return value.replace(/\b(Bearer|Token|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]');
}

function sanitizeLinkHeader(value: string): string {
  return value.replace(/<([^>]*)>/g, (_match, rawUrl: string) => {
    return `<${sanitizeUrl(rawUrl)}>`;
  });
}

function isBinary(value: unknown): boolean {
  return (
    Buffer.isBuffer(value) ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer
  );
}

function isStream(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (typeof (value as { pipe?: unknown }).pipe === 'function' ||
      typeof (value as { getReader?: unknown }).getReader === 'function'),
  );
}

function sanitizeLeaf(value: unknown, key?: string): unknown {
  const normalizedKey = key ? normalizeKey(key) : undefined;
  if (key && isSensitiveKey(key)) return REDACTED;
  if (value instanceof Date) return value.toJSON();
  if (isBinary(value)) return BINARY;
  if (isStream(value)) return STREAM;
  const stringValue =
    typeof value === 'string' ? redactCredentialValues(value) : value;
  if (
    typeof stringValue === 'string' &&
    normalizedKey &&
    LINK_KEYS.has(normalizedKey)
  ) {
    return sanitizeLinkHeader(stringValue);
  }
  const isUrlKey =
    normalizedKey &&
    (URL_KEYS.has(normalizedKey) ||
      normalizedKey.endsWith('url') ||
      normalizedKey.endsWith('uri') ||
      normalizedKey.endsWith('endpoint'));
  if (typeof stringValue === 'string' && isUrlKey) {
    return sanitizeUrl(stringValue);
  }
  return stringValue;
}

interface AncestorNode {
  value: object;
  parent?: AncestorNode;
}

function isAncestor(value: object, ancestor?: AncestorNode): boolean {
  for (let current = ancestor; current; current = current.parent) {
    if (current.value === value) return true;
  }
  return false;
}

function sanitize(value: unknown): unknown {
  const leaf = sanitizeLeaf(value);
  if (leaf !== value || !value || typeof value !== 'object') return leaf;

  const root: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? []
    : {};
  const pending: Array<{
    source: Record<string, unknown> | unknown[];
    target: Record<string, unknown> | unknown[];
    arrayItemKey?: string;
    ancestors: AncestorNode;
  }> = [
    {
      source: value as Record<string, unknown> | unknown[],
      target: root,
      ancestors: { value },
    },
  ];

  while (pending.length > 0) {
    const { source, target, arrayItemKey, ancestors } = pending.pop()!;
    for (const [key, rawValue] of Object.entries(source)) {
      const semanticKey = Array.isArray(source) ? arrayItemKey : key;
      const sanitized = sanitizeLeaf(rawValue, semanticKey);
      if (sanitized !== rawValue || !rawValue || typeof rawValue !== 'object') {
        (target as any)[key] = sanitized;
        continue;
      }
      if (isAncestor(rawValue, ancestors)) {
        (target as any)[key] = CIRCULAR;
        continue;
      }

      const childTarget: Record<string, unknown> | unknown[] = Array.isArray(
        rawValue,
      )
        ? []
        : {};
      (target as any)[key] = childTarget;
      pending.push({
        source: rawValue as Record<string, unknown> | unknown[],
        target: childTarget,
        arrayItemKey: Array.isArray(rawValue) ? semanticKey : undefined,
        ancestors: { value: rawValue, parent: ancestors },
      });
    }
  }
  return root;
}

function capBody(value: unknown): unknown {
  if (isBinary(value)) return BINARY;
  if (isStream(value)) return STREAM;

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    // Let the sanitizer replace cycles before the forwarding payload is encoded.
    return value;
  }
  const originalBytes =
    serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
  return originalBytes > OCPI_REQUEST_LOG_BODY_LIMIT_BYTES
    ? { _truncated: true, originalBytes }
    : value;
}

function extractOcpiStatusCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const body = value as Record<string, unknown>;
  let rawStatus: unknown;
  try {
    rawStatus = body.status_code ?? body.statusCode;
  } catch {
    return undefined;
  }
  const status =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string'
        ? Number(rawStatus)
        : Number.NaN;
  return Number.isInteger(status) && status >= 1000 && status <= 4999
    ? status
    : undefined;
}

export function sanitizeOcpiRequestLogPayload(
  payload: OcpiRequestLogPayload,
): OcpiRequestLogPayload {
  const ocpiStatusCode = extractOcpiStatusCode(payload.response?.body);
  const capped: OcpiRequestLogPayload = {
    ...payload,
    request: {
      ...payload.request,
      body: capBody(payload.request.body),
    },
    response: payload.response
      ? {
          ...payload.response,
          body: capBody(payload.response.body),
        }
      : undefined,
  };
  const sanitized = sanitize(capped) as OcpiRequestLogPayload;
  if (ocpiStatusCode !== undefined) sanitized.ocpiStatusCode = ocpiStatusCode;
  return sanitized;
}

@Service()
export class OcpiRequestLogClient {
  private lastFailureLogAt?: number;
  private suppressedFailureCount = 0;

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
      this.logForwardingFailure(
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
        body: JSON.stringify({
          payload: sanitizeOcpiRequestLogPayload(payload),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logForwardingFailure(
          `Gateway rejected OCPI request log with HTTP ${response.status}.`,
        );
      } else {
        this.resetFailureLogging();
      }
      await response.body?.cancel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logForwardingFailure(
        `Failed to forward OCPI request log: ${message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private logForwardingFailure(message: string): void {
    const now = Date.now();
    if (
      this.lastFailureLogAt === undefined ||
      now - this.lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS
    ) {
      const suppressed = this.suppressedFailureCount;
      this.logger.error(
        `${message}${suppressed > 0 ? ` Suppressed ${suppressed} similar failures.` : ''}`,
      );
      this.lastFailureLogAt = now;
      this.suppressedFailureCount = 0;
      return;
    }
    this.suppressedFailureCount += 1;
  }

  private resetFailureLogging(): void {
    this.lastFailureLogAt = undefined;
    this.suppressedFailureCount = 0;
  }
}
