// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { redactError } from './redactError';
import { UnsuccessfulRequestException } from '../exception/UnsuccessfulRequestException';

// Focus: whatever goes wrong talking to a partner, the message that reaches a
// log, an HTTP response, the database or an admin's screen never carries a
// credential — ours or theirs.
describe('redactError', () => {
  const OUR_TOKEN = '6f1e2d3c-4b5a-4968-8776-655443322110';
  const THEIR_TOKEN = 'partner-setup-token-abc123xyz';
  const secrets = [OUR_TOKEN, THEIR_TOKEN];

  const assertClean = (message: string) => {
    expect(message).not.toContain(OUR_TOKEN);
    expect(message).not.toContain(THEIR_TOKEN);
    expect(message).not.toMatch(/Token\s+[A-Za-z0-9+/=_-]{8,}/);
    expect(message).not.toMatch(/AccessKey\s+\S{8,}/);
  };

  it('reports a partner rejection by status and the partner’s own message', () => {
    const error = new UnsuccessfulRequestException(
      'Request did not return a successful status code',
      {
        statusCode: 401,
        result: { status_code: 2001, status_message: 'Unknown token' },
        headers: { authorization: `Token ${OUR_TOKEN}` },
      } as any,
    );

    const message = redactError(error, secrets);

    expect(message).toBe(
      'Partner answered HTTP 401: Unknown token (OCPI 2001)',
    );
    assertClean(message);
  });

  it('reads the HTTP client’s own rejection shape the same way', () => {
    // typed-rest-client throws a plain Error with the raw body as its message
    // and the status and parsed body attached.
    const body = { status_code: 2001, status_message: 'Unknown token' };
    const error = Object.assign(new Error(JSON.stringify(body)), {
      statusCode: 401,
      result: body,
    });

    expect(redactError(error, secrets)).toBe(
      'Partner answered HTTP 401: Unknown token (OCPI 2001)',
    );
  });

  it('scrubs a credential the partner echoes back in its message', () => {
    const error = new UnsuccessfulRequestException('failed', {
      statusCode: 400,
      result: { status_message: `Token ${THEIR_TOKEN} already registered` },
      headers: {},
    } as any);

    const message = redactError(error, secrets);

    expect(message).toContain('HTTP 400');
    assertClean(message);
  });

  it('reports a non-JSON body by status alone', () => {
    const error = new UnsuccessfulRequestException('failed', {
      statusCode: 502,
      result: `<html>Bad gateway, token=${OUR_TOKEN}</html>`,
      headers: {},
    } as any);

    const message = redactError(error, secrets);

    expect(message).toBe('Partner answered HTTP 502');
    assertClean(message);
  });

  it('reports a refused connection without the request it was making', () => {
    const error = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:8099'),
      {
        code: 'ECONNREFUSED',
        config: { headers: { Authorization: `Token ${OUR_TOKEN}` } },
      },
    );

    const message = redactError(error, secrets);

    expect(message).toBe('Could not reach the partner (ECONNREFUSED)');
    assertClean(message);
  });

  it('reports a timeout', () => {
    const error = Object.assign(new Error(`timeout of 30000ms exceeded`), {
      code: 'ETIMEDOUT',
    });

    expect(redactError(error, secrets)).toBe(
      'Could not reach the partner (ETIMEDOUT)',
    );
  });

  it('scrubs known secrets and token-shaped values from any other message', () => {
    const error = new Error(
      `TenantPartner missing server token: {"credentials":{"token":"${THEIR_TOKEN}"},"serverCredentials":{"token":"${OUR_TOKEN}"}} Authorization: Token ${OUR_TOKEN}`,
    );

    const message = redactError(error, secrets);

    assertClean(message);
    expect(message).toContain('[redacted]');
  });

  it('handles a thrown non-Error', () => {
    expect(redactError(`boom ${OUR_TOKEN}`, secrets)).toBe('boom [redacted]');
  });
});
