// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import 'reflect-metadata';
import { HttpMethod, OCPIRegistration } from '@citrineos/base';
import { IRestResponse } from 'typed-rest-client';
import { z } from 'zod';
import { BaseClientApi } from './BaseClientApi';

// Focus: a credentials exchange carries live tokens both ways. Debug logging
// of request bodies and responses must not write them out.
describe('BaseClientApi — credentials exchanges are not body-logged', () => {
  const OUR_TOKEN = 'our-new-token-0001';
  const THEIR_TOKEN = 'their-returned-token-0002';

  class TestClientApi extends BaseClientApi {
    constructor(private readonly url: string) {
      super();
    }
    getUrl(): string {
      return this.url;
    }
    protected override createRaw(): Promise<IRestResponse<any>> {
      return Promise.resolve({
        statusCode: 200,
        result: { status_code: 1000, data: { token: THEIR_TOKEN } },
        headers: {},
      });
    }
  }

  const call = async (url: string) => {
    const client = new TestClientApi(url);
    const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn() };
    (client as any).logger = logger;
    (client as any).ocpiRequestLogClient = { enabled: false };
    await client.request({
      fromCountryCode: 'MY',
      fromPartyId: 'REX',
      toCountryCode: 'MY',
      toPartyId: 'PRK',
      httpMethod: HttpMethod.Post,
      schema: z.any(),
      partnerProfile: {
        credentials: { token: 'setup' },
      } as OCPIRegistration.PartnerProfile,
      body: { token: OUR_TOKEN, url: 'https://x' },
    });
    return JSON.stringify(logger.debug.mock.calls);
  };

  it('logs neither our token nor theirs for a credentials call', async () => {
    const logged = await call('https://msp.test/ocpi/2.2.1/credentials');

    expect(logged).not.toContain(OUR_TOKEN);
    expect(logged).not.toContain(THEIR_TOKEN);
  });

  it('still logs bodies for other modules', async () => {
    const logged = await call('https://msp.test/ocpi/2.2.1/locations');

    expect(logged).toContain(OUR_TOKEN);
  });
});
