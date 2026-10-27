// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import * as crypto from 'crypto';
import { HttpStatus } from '@citrineos/base';
import { AdminKeyMiddleware } from './AdminKeyMiddleware';
import { OcpiConfig } from '../../config/ocpi.types';

// Wrap the real implementation so the comparison can be observed.
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

// Focus: the partner-registration admin routes answer only a caller holding
// the configured admin key — and nobody at all when no key is configured.
describe('AdminKeyMiddleware', () => {
  const KEY = 'k'.repeat(40);

  const makeMiddleware = (adminApiKey?: string) =>
    new AdminKeyMiddleware({
      registration: { adminApiKey },
    } as unknown as OcpiConfig);

  const makeContext = (authorization?: string) => ({
    request: {
      headers: authorization === undefined ? {} : { authorization },
    },
    status: 200,
    body: undefined as unknown,
    type: undefined as unknown,
  });

  const run = async (adminApiKey: string | undefined, header?: string) => {
    const context = makeContext(header);
    const next = jest.fn(async () => undefined);
    await makeMiddleware(adminApiKey).use(context, next);
    return { context, next };
  };

  it('lets a request carrying the configured key through', async () => {
    const { context, next } = await run(KEY, `AccessKey ${KEY}`);

    expect(next).toHaveBeenCalledTimes(1);
    expect(context.status).toBe(200);
  });

  it('rejects a request with no authorization header', async () => {
    const { context, next } = await run(KEY);

    expect(next).not.toHaveBeenCalled();
    expect(context.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects a request carrying the wrong key', async () => {
    const { context, next } = await run(KEY, `AccessKey ${'x'.repeat(40)}`);

    expect(next).not.toHaveBeenCalled();
    expect(context.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects a key of a different length without throwing', async () => {
    const { context, next } = await run(KEY, 'AccessKey short');

    expect(next).not.toHaveBeenCalled();
    expect(context.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects the right key under the wrong scheme', async () => {
    const { context, next } = await run(KEY, `Token ${KEY}`);

    expect(next).not.toHaveBeenCalled();
    expect(context.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it.each([
    ['not configured', undefined],
    ['configured as an empty string', ''],
  ])(
    'fails closed when the key is %s, whatever the caller sends',
    async (_label, configured) => {
      const { context, next } = await run(configured, 'AccessKey ');

      expect(next).not.toHaveBeenCalled();
      expect(context.status).toBe(HttpStatus.UNAUTHORIZED);
    },
  );

  it('compares keys in constant time', async () => {
    const compare = crypto.timingSafeEqual as jest.Mock;
    compare.mockClear();

    await run(KEY, `AccessKey ${'x'.repeat(40)}`);

    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('never echoes the presented key in the response body', async () => {
    const presented = 'leaked-' + 'z'.repeat(33);
    const { context } = await run(KEY, `AccessKey ${presented}`);

    expect(JSON.stringify(context.body)).not.toContain(presented);
  });
});
