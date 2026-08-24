// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import 'reflect-metadata';
import { HttpMethod, OCPIRegistration } from '@citrineos/base';
import Koa from 'koa';
import {
  createServer,
  IncomingHttpHeaders,
  IncomingMessage,
  Server,
  ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { z } from 'zod';
import { OcpiConfig } from '../config/ocpi.types';
import { OcpiRequestLogClient } from '../services/OcpiRequestLogClient';
import { BaseClientApi } from '../trigger/BaseClientApi';
import { OcpiRequestLogMiddleware } from '../util/middleware/OcpiRequestLogMiddleware';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

class NetworkClientApi extends BaseClientApi {
  constructor(private readonly endpoint: string) {
    super();
  }

  getUrl(): string {
    return this.endpoint;
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitFor<T>(
  promise: Promise<T>,
  description: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks = await new Promise<Buffer[]>((resolve, reject) => {
    const received: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      received.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => resolve(received));
    request.on('error', reject);
  });
  const rawBody = Buffer.concat(chunks).toString('utf8');
  return rawBody ? JSON.parse(rawBody) : undefined;
}

async function captureRequest(
  request: IncomingMessage,
): Promise<CapturedRequest> {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: await readBody(request),
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error('Unable to bind test server');
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    (
      server as Server & {
        closeAllConnections?: () => void;
      }
    ).closeAllConnections?.();
  });
}

function handleAsync(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handler(request, response).catch((error: unknown) => {
      response
        .writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: String(error) }));
    });
  };
}

function createLogClient(endpoint: string, logger: any) {
  return new OcpiRequestLogClient(
    {
      requestLog: {
        enabled: true,
        gatewayEndpoint: endpoint,
        sharedSecret: 'integration-shared-secret',
        timeoutMs: 1_000,
      },
    } as OcpiConfig,
    logger,
  );
}

function createNetworkClient(endpoint: string, requestLogClient: any) {
  const client = new NetworkClientApi(endpoint);
  (client as any).logger = {
    debug: jest.fn(),
    error: jest.fn(),
  };
  (client as any).ocpiRequestLogClient = requestLogClient;
  return client;
}

describe('OCPI request logging network boundaries', () => {
  const partnerProfile = {
    credentials: { token: 'partner-token' },
  } as OCPIRegistration.PartnerProfile;
  const responseSchema = z.object({ status_code: z.number() });

  it.each([
    HttpMethod.Get,
    HttpMethod.Post,
    HttpMethod.Put,
    HttpMethod.Patch,
    HttpMethod.Delete,
  ])(
    'uses the real RestClient and log ingest boundary for %s',
    async (method) => {
      const partnerCapture = createDeferred<CapturedRequest>();
      const ingestCapture = createDeferred<CapturedRequest>();
      let partnerServer: Server | undefined;
      let ingestServer: Server | undefined;

      try {
        partnerServer = createServer(
          handleAsync(async (request, response) => {
            partnerCapture.resolve(await captureRequest(request));
            response
              .writeHead(200, {
                'content-type': 'application/json',
                link: '<https://partner.test/next?limit=10#access_token=fragment-secret>; rel="next"',
              })
              .end(
                JSON.stringify({
                  status_code: 1000,
                  future_field: `wire-${method}`,
                }),
              );
          }),
        );
        const partnerOrigin = await listen(partnerServer);

        ingestServer = createServer(
          handleAsync(async (request, response) => {
            ingestCapture.resolve(await captureRequest(request));
            response.writeHead(202).end();
          }),
        );
        const ingestOrigin = await listen(ingestServer);

        const requestLogClient = createLogClient(
          `${ingestOrigin}/api/internal/ocpi/cpo-request-logs`,
          { error: jest.fn() },
        );
        const client = createNetworkClient(
          `${partnerOrigin}/ocpi/2.2.1/locations`,
          requestLogClient,
        );
        const requestBody =
          method === HttpMethod.Post ||
          method === HttpMethod.Put ||
          method === HttpMethod.Patch
            ? { id: 'location-1', name: `method-${method}` }
            : undefined;

        await expect(
          client.request({
            fromCountryCode: 'MY',
            fromPartyId: 'REX',
            toCountryCode: 'SG',
            toPartyId: 'ABC',
            httpMethod: method,
            schema: responseSchema,
            partnerProfile,
            body: requestBody,
            otherParams: { limit: 10, offset: 5 },
          }),
        ).resolves.toEqual({ status_code: 1000 });

        const [wireRequest, ingestRequest] = await Promise.all([
          waitFor(partnerCapture.promise, 'partner request'),
          waitFor(ingestCapture.promise, 'request-log ingest'),
        ]);
        const expectedWireUrl = '/ocpi/2.2.1/locations?limit=10&offset=5';
        const envelope = ingestRequest.body as any;

        expect(wireRequest.method).toBe(method);
        expect(wireRequest.url).toBe(expectedWireUrl);
        expect(wireRequest.body).toEqual(requestBody);
        expect(ingestRequest.method).toBe('POST');
        expect(ingestRequest.url).toBe('/api/internal/ocpi/cpo-request-logs');
        expect(ingestRequest.headers['x-ocpi-log-secret']).toBe(
          'integration-shared-secret',
        );
        expect(envelope.payload.request.method).toBe(method);
        expect(new URL(envelope.payload.request.url).pathname).toBe(
          '/ocpi/2.2.1/locations',
        );
        expect(new URL(envelope.payload.request.url).search).toBe(
          new URL(`${partnerOrigin}${expectedWireUrl}`).search,
        );
        const authorizationHeader = Object.entries(
          envelope.payload.request.headers,
        ).find(([key]) => key.toLowerCase() === 'authorization');
        expect(authorizationHeader?.[1]).toBe('[REDACTED]');
        expect(envelope.payload.request.body).toEqual(requestBody);
        expect(envelope.payload.response.status).toBe(200);
        expect(envelope.payload.response.body).toEqual({
          status_code: 1000,
          future_field: `wire-${method}`,
        });
        expect(envelope.payload.response.headers.link).not.toContain(
          'fragment-secret',
        );
      } finally {
        await Promise.all([
          closeServer(partnerServer),
          closeServer(ingestServer),
        ]);
      }
    },
  );

  it('forwards the real non-2xx status and body from typed-rest-client', async () => {
    const ingestCapture = createDeferred<CapturedRequest>();
    let partnerServer: Server | undefined;
    let ingestServer: Server | undefined;

    try {
      partnerServer = createServer((_request, response) => {
        response
          .writeHead(502, {
            'content-type': 'application/json',
            'x-upstream-error': 'true',
          })
          .end(
            JSON.stringify({
              status_code: 3000,
              status_message: 'partner down',
            }),
          );
      });
      const partnerOrigin = await listen(partnerServer);

      ingestServer = createServer(
        handleAsync(async (request, response) => {
          ingestCapture.resolve(await captureRequest(request));
          response.writeHead(202).end();
        }),
      );
      const ingestOrigin = await listen(ingestServer);
      const client = createNetworkClient(
        `${partnerOrigin}/ocpi/2.2.1/locations`,
        createLogClient(`${ingestOrigin}/ingest`, { error: jest.fn() }),
      );

      await expect(
        client.request({
          fromCountryCode: 'MY',
          fromPartyId: 'REX',
          toCountryCode: 'SG',
          toPartyId: 'ABC',
          httpMethod: HttpMethod.Get,
          schema: responseSchema,
          partnerProfile,
        }),
      ).rejects.toMatchObject({ statusCode: 502 });

      const ingestRequest = await waitFor(
        ingestCapture.promise,
        'non-2xx request-log ingest',
      );
      expect((ingestRequest.body as any).payload.response).toEqual({
        status: 502,
        headers: expect.objectContaining({ 'x-upstream-error': 'true' }),
        body: {
          status_code: 3000,
          status_message: 'partner down',
        },
      });
    } finally {
      await Promise.all([
        closeServer(partnerServer),
        closeServer(ingestServer),
      ]);
    }
  });

  it('follows partner redirects with the original authorization while logging the registered endpoint', async () => {
    const ingestCapture = createDeferred<CapturedRequest>();
    let redirectedRequestReceived = false;
    let registeredEndpointAuthorization: string | undefined;
    let redirectedEndpointAuthorization: string | undefined;
    let redirectServer: Server | undefined;
    let redirectTarget: Server | undefined;
    let ingestServer: Server | undefined;

    try {
      redirectTarget = createServer((request, response) => {
        redirectedRequestReceived = true;
        redirectedEndpointAuthorization = request.headers.authorization;
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status_code: 1000 }));
      });
      const targetOrigin = await listen(redirectTarget);

      redirectServer = createServer((request, response) => {
        registeredEndpointAuthorization = request.headers.authorization;
        response
          .writeHead(307, {
            location: `${targetOrigin}/ocpi/2.2.1/locations`,
          })
          .end();
      });
      const redirectOrigin = await listen(redirectServer);

      ingestServer = createServer(
        handleAsync(async (request, response) => {
          ingestCapture.resolve(await captureRequest(request));
          response.writeHead(202).end();
        }),
      );
      const ingestOrigin = await listen(ingestServer);
      const client = createNetworkClient(
        `${redirectOrigin}/ocpi/2.2.1/locations`,
        createLogClient(`${ingestOrigin}/ingest`, { error: jest.fn() }),
      );

      await expect(
        client.request({
          fromCountryCode: 'MY',
          fromPartyId: 'REX',
          toCountryCode: 'SG',
          toPartyId: 'ABC',
          httpMethod: HttpMethod.Get,
          schema: responseSchema,
          partnerProfile,
        }),
      ).resolves.toEqual({ status_code: 1000 });

      const ingestRequest = await waitFor(
        ingestCapture.promise,
        'redirect request-log ingest',
      );
      const payload = (ingestRequest.body as any).payload;

      expect(redirectedRequestReceived).toBe(true);
      expect(registeredEndpointAuthorization).toBe('Token partner-token');
      expect(redirectedEndpointAuthorization).toBe('Token partner-token');
      expect(payload.request.url).toBe(
        `${redirectOrigin}/ocpi/2.2.1/locations`,
      );
      expect(payload.response).toEqual(
        expect.objectContaining({
          status: 200,
          body: { status_code: 1000 },
        }),
      );
    } finally {
      await Promise.all([
        closeServer(redirectServer),
        closeServer(redirectTarget),
        closeServer(ingestServer),
      ]);
    }
  });

  it('captures an incoming Koa request and delivers it through real fetch', async () => {
    const ingestCapture = createDeferred<CapturedRequest>();
    let ingestServer: Server | undefined;
    let applicationServer: Server | undefined;

    try {
      ingestServer = createServer(
        handleAsync(async (request, response) => {
          ingestCapture.resolve(await captureRequest(request));
          response.writeHead(202).end();
        }),
      );
      const ingestOrigin = await listen(ingestServer);
      const requestLogClient = createLogClient(`${ingestOrigin}/ingest`, {
        error: jest.fn(),
      });
      const middleware = new OcpiRequestLogMiddleware(requestLogClient, {
        error: jest.fn(),
      } as any);
      const app = new Koa();

      app.use(async (context, next) => {
        (context.request as any).body = await readBody(context.req);
        await next();
      });
      app.use((context, next) => middleware.use(context, next));
      app.use(async (context) => {
        (context as any).params = { location_id: 'location-1' };
        context.state.tenantPartner = {
          id: 12,
          countryCode: 'MY',
          partyId: 'ABC',
        };
        context.status = 200;
        context.body = {
          status_code: 1000,
          future_field: 'incoming-wire',
        };
      });
      applicationServer = createServer(app.callback());
      const applicationOrigin = await listen(applicationServer);

      const response = await fetch(
        `${applicationOrigin}/ocpi/2.2.1/locations/location-1?client_secret=query-secret`,
        {
          method: 'PUT',
          headers: {
            authorization: 'Token incoming-secret',
            'content-type': 'application/json',
            'x-auth-token': 'header-secret',
            'x-request-id': 'incoming-request-1',
          },
          body: JSON.stringify({ id: 'location-1' }),
        },
      );

      await expect(response.json()).resolves.toEqual({
        status_code: 1000,
        future_field: 'incoming-wire',
      });
      const ingestRequest = await waitFor(
        ingestCapture.promise,
        'incoming request-log ingest',
      );
      const payload = (ingestRequest.body as any).payload;

      expect(ingestRequest.headers['x-ocpi-log-secret']).toBe(
        'integration-shared-secret',
      );
      expect(payload).toEqual(
        expect.objectContaining({
          direction: 'INCOMING',
          locationId: 'location-1',
          requestId: 'incoming-request-1',
          partner: {
            tenantPartnerId: 12,
            countryCode: 'MY',
            partyId: 'ABC',
          },
          request: expect.objectContaining({
            method: 'PUT',
            body: { id: 'location-1' },
          }),
          response: expect.objectContaining({
            status: 200,
            body: {
              status_code: 1000,
              future_field: 'incoming-wire',
            },
          }),
        }),
      );
      expect(payload.request.url).toContain('client_secret=%5BREDACTED%5D');
      expect(payload.request.headers.authorization).toBe('[REDACTED]');
      expect(payload.request.headers['x-auth-token']).toBe('[REDACTED]');
    } finally {
      await Promise.all([
        closeServer(applicationServer),
        closeServer(ingestServer),
      ]);
    }
  });
});
