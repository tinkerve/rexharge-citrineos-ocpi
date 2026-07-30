// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import 'reflect-metadata';
import { HttpMethod, OCPIRegistration } from '@citrineos/base';
import { createServer, Server } from 'node:http';
import { IRestResponse } from 'typed-rest-client';
import { z } from 'zod';
import { BaseClientApi } from './BaseClientApi';

class TestClientApi extends BaseClientApi {
  response: IRestResponse<unknown> = {
    statusCode: 200,
    result: { status_code: 1000 },
    headers: {},
  };

  getUrl(): string {
    return 'https://partner.test/ocpi/2.2.1/locations';
  }

  protected override getRaw(): Promise<IRestResponse<any>> {
    return Promise.resolve(this.response);
  }

  protected override createRaw(): Promise<IRestResponse<any>> {
    return Promise.resolve(this.response);
  }

  protected override replaceRaw(): Promise<IRestResponse<any>> {
    return Promise.resolve(this.response);
  }

  protected override updateRaw(): Promise<IRestResponse<any>> {
    return Promise.resolve(this.response);
  }

  protected override delRaw(): Promise<IRestResponse<any>> {
    return Promise.resolve(this.response);
  }
}

class RealTestClientApi extends BaseClientApi {
  constructor(private readonly endpoint: string) {
    super();
  }

  getUrl(): string {
    return this.endpoint;
  }
}

describe('BaseClientApi request logging wrapper', () => {
  const partnerProfile = {
    credentials: { token: 'partner-token' },
  } as OCPIRegistration.PartnerProfile;
  const schema = z.object({ status_code: z.number() });

  function createClient() {
    const client = new TestClientApi();
    (client as any).logger = {
      debug: jest.fn(),
      error: jest.fn(),
    };
    (client as any).ocpiRequestLogClient = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    return client;
  }

  function createRealClient(endpoint: string) {
    const client = new RealTestClientApi(endpoint);
    (client as any).logger = {
      debug: jest.fn(),
      error: jest.fn(),
    };
    (client as any).ocpiRequestLogClient = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    return client;
  }

  function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  it.each([
    HttpMethod.Get,
    HttpMethod.Post,
    HttpMethod.Put,
    HttpMethod.Patch,
    HttpMethod.Delete,
  ])('preserves the parsed response for %s', async (method) => {
    const client = createClient();

    await expect(
      client.request(
        'MY',
        'REX',
        'SG',
        'ABC',
        method,
        schema,
        partnerProfile,
        true,
        undefined,
        { id: 'location-1' },
        undefined,
        undefined,
        undefined,
        undefined,
        55,
      ),
    ).resolves.toEqual({ status_code: 1000 });

    expect((client as any).ocpiRequestLogClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'OUTGOING',
        locationId: 55,
        partner: { countryCode: 'SG', partyId: 'ABC' },
        request: expect.objectContaining({ method }),
        response: expect.objectContaining({ status: 200 }),
      }),
    );
  });

  it('rethrows the existing response error unchanged', async () => {
    const client = createClient();
    client.response = {
      statusCode: 500,
      result: { status_code: 3000 },
      headers: {},
    };

    await expect(
      client.request(
        'MY',
        'REX',
        'SG',
        'ABC',
        HttpMethod.Get,
        schema,
        partnerProfile,
      ),
    ).rejects.toMatchObject({ name: 'UnsuccessfulRequestException' });
    expect((client as any).ocpiRequestLogClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({ status: 500 }),
      }),
    );
  });

  it('skips response snapshots when request logging is disabled', async () => {
    const client = createClient();
    (client as any).ocpiRequestLogClient.enabled = false;
    const snapshotResponse = jest.spyOn(client as any, 'snapshotResponse');

    await expect(
      client.request(
        'MY',
        'REX',
        'SG',
        'ABC',
        HttpMethod.Get,
        schema,
        partnerProfile,
      ),
    ).resolves.toEqual({ status_code: 1000 });

    client.response = {
      statusCode: 500,
      result: { status_code: 3000 },
      headers: {},
    };
    await expect(
      client.request(
        'MY',
        'REX',
        'SG',
        'ABC',
        HttpMethod.Get,
        schema,
        partnerProfile,
      ),
    ).rejects.toMatchObject({ name: 'UnsuccessfulRequestException' });

    expect(snapshotResponse).not.toHaveBeenCalled();
    expect((client as any).ocpiRequestLogClient.send).not.toHaveBeenCalled();
  });

  it('logs the full response and effective URL without changing parsed output', async () => {
    const client = createClient();
    client.response = {
      statusCode: 200,
      result: { status_code: 1000, future_field: 'preserved-in-log' },
      headers: {},
    };

    await expect(
      client.request(
        'MY',
        'REX',
        'SG',
        'ABC',
        HttpMethod.Get,
        schema,
        partnerProfile,
        true,
        undefined,
        undefined,
        {
          offset: 0,
          limit: 10,
          date_from: '2026-07-01T00:00:00Z',
        },
        { token: 'query-token' },
      ),
    ).resolves.toEqual({ status_code: 1000 });

    expect((client as any).ocpiRequestLogClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ url: expect.any(String) }),
        response: expect.objectContaining({
          body: {
            status_code: 1000,
            future_field: 'preserved-in-log',
          },
        }),
      }),
    );
    const sentPayload = (client as any).ocpiRequestLogClient.send.mock
      .calls[0][0];
    const loggedUrl = new URL(sentPayload.request.url);
    expect(loggedUrl.searchParams.get('limit')).toBe('10');
    expect(loggedUrl.searchParams.get('date_from')).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(loggedUrl.searchParams.get('token')).toBe('query-token');
  });

  it('recovers a rejected typed-rest-client response from the real error shape', async () => {
    const server = createServer((_request, response) => {
      response
        .writeHead(502, {
          'content-type': 'application/json',
          'x-upstream-error': 'true',
        })
        .end(JSON.stringify({ status_code: 3000, status_message: 'down' }));
    });

    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Unable to bind test server');
      }
      const client = createRealClient(
        `http://127.0.0.1:${address.port}/ocpi/2.2.1/locations`,
      );

      await expect(
        client.request(
          'MY',
          'REX',
          'SG',
          'ABC',
          HttpMethod.Get,
          schema,
          partnerProfile,
        ),
      ).rejects.toMatchObject({ statusCode: 502 });

      expect((client as any).ocpiRequestLogClient.send).toHaveBeenCalledWith(
        expect.objectContaining({
          response: {
            status: 502,
            headers: expect.objectContaining({ 'x-upstream-error': 'true' }),
            body: { status_code: 3000, status_message: 'down' },
          },
        }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it('logs the same POST URL that typed-rest-client sends on the wire', async () => {
    let wireUrl: string | undefined;
    const server = createServer((request, response) => {
      wireUrl = request.url;
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status_code: 1000 }));
    });

    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Unable to bind test server');
      }
      const client = createRealClient(
        `http://127.0.0.1:${address.port}/ocpi/2.2.1/tokens`,
      );

      await client.request(
        'MY',
        'REX',
        'SG',
        'ABC',
        HttpMethod.Post,
        schema,
        partnerProfile,
        true,
        undefined,
        { uid: 'token-1' },
        undefined,
        { type: 'RFID' },
      );

      const loggedUrl = (client as any).ocpiRequestLogClient.send.mock
        .calls[0][0].request.url;
      expect(wireUrl).toBe('/ocpi/2.2.1/tokens');
      expect(new URL(loggedUrl).search).toBe('');
    } finally {
      await closeServer(server);
    }
  });

  it('snapshots the wire body before pagination parsing mutates the result', async () => {
    const client = createClient();
    client.response = {
      statusCode: 200,
      result: { status_code: 1000, data: [] },
      headers: {
        'x-total-count': '20',
        'x-limit': '10',
        link: '<https://partner.test/next?offset=10>; rel="next"',
      },
    };

    await client.request(
      'MY',
      'REX',
      'SG',
      'ABC',
      HttpMethod.Get,
      schema,
      partnerProfile,
    );

    expect((client as any).ocpiRequestLogClient.send).toHaveBeenCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({
          body: { status_code: 1000, data: [] },
        }),
      }),
    );
    expect(client.response.result).toEqual(
      expect.objectContaining({
        total: 20,
        limit: 10,
        offset: 10,
      }),
    );
  });
});
