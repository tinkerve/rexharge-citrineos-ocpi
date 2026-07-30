// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import 'reflect-metadata';
import { createServer, Server } from 'node:http';
import { OcpiConfig } from '../config/ocpi.types';
import { OcpiRequestLogClient } from './OcpiRequestLogClient';

describe('OcpiRequestLogClient', () => {
  const logger = {
    error: jest.fn(),
  } as any;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('does no work when request logging is disabled', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    const client = new OcpiRequestLogClient(
      {
        requestLog: {
          enabled: false,
          gatewayEndpoint: '',
          sharedSecret: '',
          timeoutMs: 100,
        },
      } as OcpiConfig,
      logger,
    );

    await client.send({
      direction: 'INCOMING',
      request: { method: 'GET', url: '/ocpi/2.2.1/locations' },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redacts credentials before forwarding and swallows delivery failures', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('gateway unavailable'));
    const client = new OcpiRequestLogClient(
      {
        requestLog: {
          enabled: true,
          gatewayEndpoint: 'http://gateway/api/internal/ocpi/cpo-request-logs',
          sharedSecret: 'shared-secret',
          timeoutMs: 100,
        },
      } as OcpiConfig,
      logger,
    );

    await expect(
      client.send({
        direction: 'OUTGOING',
        request: {
          method: 'PUT',
          url: 'https://partner/locations/1?token=query-secret',
          headers: { authorization: 'Token private' },
          body: { credentials: { token: 'private-token' } },
        },
      }),
    ).resolves.toBeUndefined();

    const request = fetchSpy.mock.calls[0][1]!;
    const event = JSON.parse(request.body as string);
    expect(event.payload.request.headers.authorization).toBe('[REDACTED]');
    expect(event.payload.request.body.credentials).toBe('[REDACTED]');
    expect(event.payload.request.url).toContain('token=%5BREDACTED%5D');
    expect(request.redirect).toBe('error');
    expect(request.headers).toEqual(
      expect.objectContaining({
        'x-ocpi-log-secret': 'shared-secret',
      }),
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('removes URL userinfo and common credential aliases', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(undefined, {
        status: 202,
      }),
    );
    const client = new OcpiRequestLogClient(
      {
        requestLog: {
          enabled: true,
          gatewayEndpoint: 'http://gateway/api/internal/ocpi/cpo-request-logs',
          sharedSecret: 'shared-secret',
          timeoutMs: 100,
        },
      } as OcpiConfig,
      logger,
    );

    await client.send({
      direction: 'OUTGOING',
      request: {
        method: 'GET',
        url: 'https://alice:password@partner.test/ocpi?client_secret=secret&x_access_token=query-secret',
        headers: {
          'x-api-key': 'api-key',
          'x-auth-token': 'auth-token',
          'x-access-token': 'access-token',
          'x-bearer-token': 'bearer-token',
          'x-refresh-token': 'refresh-token',
          'x-client-secret': 'client-secret',
          'x-credential': 'credential',
          'x-id-token': 'id-token',
          'x-password': 'password',
          'x-private-key': 'private-key',
          'x-shared-secret': 'shared-secret',
          'Proxy-Authorization': 'Basic secret',
          Link: '<https://partner.test/next?limit=10#access_token=fragment-secret>; rel="next"',
        },
        body: { at: new Date('2026-07-29T00:00:00.000Z') },
      },
    });

    const event = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(event.payload.request.url).toBe(
      'https://partner.test/ocpi?client_secret=%5BREDACTED%5D&x_access_token=%5BREDACTED%5D',
    );
    expect(event.payload.request.headers).toEqual({
      'x-api-key': '[REDACTED]',
      'x-auth-token': '[REDACTED]',
      'x-access-token': '[REDACTED]',
      'x-bearer-token': '[REDACTED]',
      'x-refresh-token': '[REDACTED]',
      'x-client-secret': '[REDACTED]',
      'x-credential': '[REDACTED]',
      'x-id-token': '[REDACTED]',
      'x-password': '[REDACTED]',
      'x-private-key': '[REDACTED]',
      'x-shared-secret': '[REDACTED]',
      'Proxy-Authorization': '[REDACTED]',
      Link: expect.stringContaining('[REDACTED]'),
    });
    expect(event.payload.request.headers.Link).not.toContain('fragment-secret');
    expect(event.payload.request.body.at).toBe('2026-07-29T00:00:00.000Z');
  });

  it('sanitizes every URL in array-valued headers and handles cycles', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(undefined, {
        status: 202,
      }),
    );
    const client = new OcpiRequestLogClient(
      {
        requestLog: {
          enabled: true,
          gatewayEndpoint: 'http://gateway/api/internal/ocpi/cpo-request-logs',
          sharedSecret: 'shared-secret',
          timeoutMs: 100,
        },
      } as OcpiConfig,
      logger,
    );
    const cyclicBody: Record<string, unknown> = {
      value: 'preserved',
    };
    cyclicBody.self = cyclicBody;

    await client.send({
      direction: 'OUTGOING',
      request: {
        method: 'GET',
        url: 'https://partner.test/ocpi',
        headers: {
          Link: [
            '<https://partner.test/next?token=link-secret>; rel="next"',
            '<https://partner.test/previous#access_token=fragment-secret>; rel="previous"',
          ],
          Location: [
            'https://alice:password@partner.test/callback?client_secret=location-secret',
            '/relative?x_auth_token=relative-secret',
          ],
          Referer: ['https://partner.test/source?refresh_token=referer-secret'],
        },
        body: cyclicBody,
      },
    });

    const event = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(event.payload.request.headers.Link).toEqual([
      '<https://partner.test/next?token=%5BREDACTED%5D>; rel="next"',
      '<https://partner.test/previous#access_token=[REDACTED]>; rel="previous"',
    ]);
    expect(event.payload.request.headers.Location).toEqual([
      'https://partner.test/callback?client_secret=%5BREDACTED%5D',
      '/relative?x_auth_token=%5BREDACTED%5D',
    ]);
    expect(event.payload.request.headers.Referer).toEqual([
      'https://partner.test/source?refresh_token=%5BREDACTED%5D',
    ]);
    expect(event.payload.request.body).toEqual({
      value: 'preserved',
      self: '[Circular]',
    });
    expect(fetchSpy.mock.calls[0][1]!.body as string).not.toMatch(
      /link-secret|fragment-secret|location-secret|relative-secret|referer-secret|password/,
    );
  });

  it('does not forward the secret or payload across redirects', async () => {
    let redirectedRequestReceived = false;
    let redirectorRequest:
      | {
          method?: string;
          secret?: string | string[];
          body: string;
        }
      | undefined;
    let target: Server | undefined;
    let redirector: Server | undefined;

    try {
      target = createServer((_request, response) => {
        redirectedRequestReceived = true;
        response.writeHead(202).end();
      });
      await new Promise<void>((resolve) =>
        target!.listen(0, '127.0.0.1', resolve),
      );
      const targetAddress = target.address();
      if (!targetAddress || typeof targetAddress === 'string') {
        throw new Error('Unable to bind redirect target');
      }

      redirector = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on('end', () => {
          redirectorRequest = {
            method: request.method,
            secret: request.headers['x-ocpi-log-secret'],
            body: Buffer.concat(chunks).toString('utf8'),
          };
          response
            .writeHead(307, {
              location: `http://127.0.0.1:${targetAddress.port}/capture`,
            })
            .end();
        });
      });
      await new Promise<void>((resolve) =>
        redirector!.listen(0, '127.0.0.1', resolve),
      );
      const redirectAddress = redirector.address();
      if (!redirectAddress || typeof redirectAddress === 'string') {
        throw new Error('Unable to bind redirect server');
      }

      const client = new OcpiRequestLogClient(
        {
          requestLog: {
            enabled: true,
            gatewayEndpoint: `http://127.0.0.1:${redirectAddress.port}/ingest`,
            sharedSecret: 'must-not-cross-origin',
            timeoutMs: 1_000,
          },
        } as OcpiConfig,
        logger,
      );

      await client.send({
        direction: 'INCOMING',
        request: { method: 'POST', url: '/ocpi/2.2.1/commands' },
      });

      expect(redirectedRequestReceived).toBe(false);
      expect(redirectorRequest).toEqual({
        method: 'POST',
        secret: 'must-not-cross-origin',
        body: expect.stringContaining('"direction":"INCOMING"'),
      });
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to forward OCPI request log'),
      );
    } finally {
      await Promise.all(
        [redirector, target]
          .filter((server): server is Server => Boolean(server))
          .map(
            (server) =>
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
      );
    }
  });

  it('aborts a real ingest request at the configured timeout', async () => {
    let requestReceived = false;
    const server = createServer((_request, _response) => {
      requestReceived = true;
      // Keep the response open until the client aborts the request.
    });

    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Unable to bind timeout server');
      }
      const client = new OcpiRequestLogClient(
        {
          requestLog: {
            enabled: true,
            gatewayEndpoint: `http://127.0.0.1:${address.port}/ingest`,
            sharedSecret: 'timeout-shared-secret',
            timeoutMs: 100,
          },
        } as OcpiConfig,
        logger,
      );
      const startedAt = Date.now();

      await client.send({
        direction: 'INCOMING',
        request: { method: 'GET', url: '/ocpi/2.2.1/locations' },
      });

      expect(requestReceived).toBe(true);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
      expect(Date.now() - startedAt).toBeLessThan(750);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to forward OCPI request log'),
      );
    } finally {
      (
        server as Server & {
          closeAllConnections?: () => void;
        }
      ).closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('cancels an accepted response body instead of leaving the connection open', async () => {
    let responseClosed!: () => void;
    const responseClosedPromise = new Promise<void>((resolve) => {
      responseClosed = resolve;
    });
    const server = createServer((_request, response) => {
      response.on('close', responseClosed);
      response.writeHead(202);
      response.flushHeaders();
      // The Gateway contract has no response body. Keep this deliberately open
      // to prove the client releases an abnormal upstream connection.
    });

    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Unable to bind response-body server');
      }
      const client = new OcpiRequestLogClient(
        {
          requestLog: {
            enabled: true,
            gatewayEndpoint: `http://127.0.0.1:${address.port}/ingest`,
            sharedSecret: 'response-body-shared-secret',
            timeoutMs: 1_000,
          },
        } as OcpiConfig,
        logger,
      );

      await client.send({
        direction: 'INCOMING',
        request: { method: 'GET', url: '/ocpi/2.2.1/locations' },
      });
      let closeWaitTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await expect(
          Promise.race([
            responseClosedPromise,
            new Promise<never>((_resolve, reject) => {
              closeWaitTimeout = setTimeout(
                () => reject(new Error('Response connection stayed open')),
                500,
              );
            }),
          ]),
        ).resolves.toBeUndefined();
      } finally {
        if (closeWaitTimeout) clearTimeout(closeWaitTimeout);
      }
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      (
        server as Server & {
          closeAllConnections?: () => void;
        }
      ).closeAllConnections?.();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
