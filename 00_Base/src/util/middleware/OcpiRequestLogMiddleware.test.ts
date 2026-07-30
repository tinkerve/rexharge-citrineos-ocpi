// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import 'reflect-metadata';
import { OcpiRequestLogMiddleware } from './OcpiRequestLogMiddleware';

describe('OcpiRequestLogMiddleware', () => {
  it('captures incoming request metadata after downstream middleware runs', async () => {
    const client = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    const middleware = new OcpiRequestLogMiddleware(
      client as any,
      {
        error: jest.fn(),
      } as any,
    );
    const context: any = {
      request: {
        method: 'PUT',
        originalUrl: '/ocpi/2.2.1/locations/location-1',
        headers: { 'x-request-id': 'request-1' },
        body: { id: 'location-1' },
      },
      response: { headers: {} },
      state: {},
      params: { location_id: 'location-1' },
    };

    await middleware.use(context, async () => {
      context.state.tenantPartner = {
        id: 12,
        countryCode: 'MY',
        partyId: 'ABC',
      };
      context.status = 200;
      context.body = { status_code: 1000 };
    });

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'INCOMING',
        locationId: 'location-1',
        partner: {
          tenantPartnerId: 12,
          countryCode: 'MY',
          partyId: 'ABC',
        },
        response: expect.objectContaining({ status: 200 }),
      }),
    );
  });

  it('snapshots request metadata before downstream code can mutate it', async () => {
    const client = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    const middleware = new OcpiRequestLogMiddleware(
      client as any,
      {
        error: jest.fn(),
      } as any,
    );
    const context: any = {
      request: {
        method: 'PUT',
        originalUrl: '/ocpi/2.2.1/locations/location-1',
        headers: {
          authorization: 'Token original',
          'x-request-id': 'request-before-next',
        },
        body: { id: 'location-1', name: 'original' },
      },
      response: { headers: {} },
      state: {},
      params: { location_id: 'location-1' },
    };

    await middleware.use(context, async () => {
      context.request.method = 'DELETE';
      context.request.originalUrl = '/mutated';
      context.request.headers.authorization = 'Token mutated';
      context.request.headers['x-request-id'] = 'request-after-next';
      context.request.body.name = 'mutated';
      context.status = 200;
      context.body = { status_code: 1000 };
    });

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-before-next',
        request: {
          method: 'PUT',
          url: '/ocpi/2.2.1/locations/location-1',
          headers: {
            authorization: 'Token original',
            'x-request-id': 'request-before-next',
          },
          body: { id: 'location-1', name: 'original' },
        },
      }),
    );
  });

  it('rethrows the original downstream error after logging it', async () => {
    const client = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    const middleware = new OcpiRequestLogMiddleware(
      client as any,
      {
        error: jest.fn(),
      } as any,
    );
    const original = new Error('controller failed');
    const context: any = {
      request: {
        method: 'POST',
        originalUrl: '/ocpi/2.2.1/commands',
        headers: {},
      },
      response: { headers: {} },
      state: {},
      params: {},
      status: 500,
    };

    await expect(
      middleware.use(context, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { name: 'Error', message: 'controller failed' },
      }),
    );
  });

  it('preserves metadata for a non-Error thrown value', async () => {
    const client = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    const middleware = new OcpiRequestLogMiddleware(
      client as any,
      {
        error: jest.fn(),
      } as any,
    );
    const thrownValue = 'controller failed without an Error object';
    const context: any = {
      request: {
        method: 'POST',
        originalUrl: '/ocpi/2.2.1/commands',
        headers: {},
      },
      response: { headers: {} },
      state: {},
      params: {},
      status: 500,
    };

    await expect(
      middleware.use(context, async () => {
        throw thrownValue;
      }),
    ).rejects.toBe(thrownValue);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          name: 'NonErrorThrown',
          message: thrownValue,
        },
      }),
    );
  });

  it('preserves name and message from a thrown plain object', async () => {
    const client = {
      enabled: true,
      send: jest.fn().mockResolvedValue(undefined),
    };
    const middleware = new OcpiRequestLogMiddleware(
      client as any,
      {
        error: jest.fn(),
      } as any,
    );
    const thrownValue = {
      name: 'PartnerResponseError',
      message: 'partner rejected the request',
    };
    const context: any = {
      request: {
        method: 'POST',
        originalUrl: '/ocpi/2.2.1/commands',
        headers: {},
      },
      response: { headers: {} },
      state: {},
      params: {},
      status: 502,
    };

    await expect(
      middleware.use(context, async () => {
        throw thrownValue;
      }),
    ).rejects.toBe(thrownValue);
    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: {
          name: 'PartnerResponseError',
          message: 'partner rejected the request',
        },
      }),
    );
  });

  it.each(['/ocpi/versions', '/ocpi/versions/2.2.1'])(
    'logs Versions active-module traffic at %s',
    async (originalUrl) => {
      const client = {
        enabled: true,
        send: jest.fn().mockResolvedValue(undefined),
      };
      const middleware = new OcpiRequestLogMiddleware(
        client as any,
        { error: jest.fn() } as any,
      );

      await middleware.use(
        {
          request: { method: 'GET', originalUrl, headers: {} },
          response: { headers: {} },
          state: {},
          params: {},
          status: 200,
          body: { status_code: 1000 },
        },
        async () => undefined,
      );

      expect(client.send).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'INCOMING',
          request: expect.objectContaining({
            method: 'GET',
            url: originalUrl,
          }),
        }),
      );
    },
  );

  it.each(['/ocpi/health', '/docs', '/ocpi/not-a-module', '/unknown'])(
    'does not log non-module traffic at %s',
    async (originalUrl) => {
      const client = {
        enabled: true,
        send: jest.fn().mockResolvedValue(undefined),
      };
      const middleware = new OcpiRequestLogMiddleware(
        client as any,
        { error: jest.fn() } as any,
      );

      await middleware.use(
        {
          request: { method: 'GET', originalUrl, headers: {} },
        },
        async () => undefined,
      );

      expect(client.send).not.toHaveBeenCalled();
    },
  );
});
