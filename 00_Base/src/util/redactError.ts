// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { UnsuccessfulRequestException } from '../exception/UnsuccessfulRequestException';

const REDACTED = '[redacted]';
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNABORTED',
  'EHOSTUNREACH',
]);

// Credential-shaped fragments that can appear in any free-text message.
const CREDENTIAL_PATTERNS: Array<[RegExp, string]> = [
  // A scheme followed by something credential-shaped (8+ token characters),
  // so prose such as "Unknown token (OCPI 2001)" is left alone.
  [/\b(Token|AccessKey|Bearer)\s+[A-Za-z0-9+/=_.-]{8,}/gi, `$1 ${REDACTED}`],
  [/("?(?:token|authorization)"?\s*[:=]\s*)"[^"]*"/gi, `$1"${REDACTED}"`],
  [/\b(token|authorization)=[^\s&"',}]+/gi, `$1=${REDACTED}`],
];

/**
 * Turns an error from talking to a partner into a message safe to log, return
 * in a response, store, and show an admin.
 *
 * Built from known-safe parts where the error's shape is known — status code
 * and the partner's own status message — and scrubbed of the given secrets and
 * anything credential-shaped otherwise. Never serialises the error object: an
 * HTTP client error carries the outbound Authorization header.
 */
export function redactError(error: unknown, secrets: string[] = []): string {
  return scrub(describe(error), secrets);
}

function describe(error: unknown): string {
  const rejection = httpRejection(error);
  if (rejection) {
    const { statusCode, result } = rejection;
    const body = result && typeof result === 'object' ? (result as any) : null;
    const partnerMessage =
      typeof body?.status_message === 'string' ? body.status_message : null;
    const ocpiCode =
      typeof body?.status_code === 'number'
        ? ` (OCPI ${body.status_code})`
        : '';
    return partnerMessage
      ? `Partner answered HTTP ${statusCode}: ${partnerMessage}${ocpiCode}`
      : `Partner answered HTTP ${statusCode}`;
  }

  const code = (error as any)?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return `Could not reach the partner (${code})`;
  }

  if (error instanceof Error) return error.message;
  return String(error);
}

function scrub(message: string, secrets: string[]): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    safe = safe.replace(pattern, replacement);
  }
  return safe;
}

/**
 * The partner answered with a non-2xx status. Two shapes reach us: our own
 * UnsuccessfulRequestException, and typed-rest-client's plain Error carrying
 * `statusCode` and the parsed body as `result` (its message is the raw body).
 */
function httpRejection(
  error: unknown,
): { statusCode: number; result: unknown } | null {
  if (error instanceof UnsuccessfulRequestException && error.iRestResponse) {
    return error.iRestResponse;
  }
  const statusCode = (error as any)?.statusCode;
  if (typeof statusCode === 'number') {
    return { statusCode, result: (error as any).result };
  }
  return null;
}

/**
 * Whether the partner gave a definite HTTP answer. A timeout or dropped
 * connection is not one: the partner may have acted on the request anyway.
 */
export function partnerAnswered(error: unknown): boolean {
  return httpRejection(error) !== null;
}
