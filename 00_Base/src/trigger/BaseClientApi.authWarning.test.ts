// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import 'reflect-metadata';
import { HttpMethod, OCPIRegistration } from '@citrineos/base';
import { IRestResponse } from 'typed-rest-client';
import { z } from 'zod';
import { BaseClientApi } from './BaseClientApi';

// Focus: a partner refusing our credentials is said out loud — one greppable
// warning naming the partner, the module and the status — and the call itself
// behaves exactly as before.
describe('BaseClientApi — outbound auth rejection warning', () => {
  const TOKEN = 'partner-issued-token-0001';
  const partnerProfile = {
    credentials: { token: TOKEN },
  } as OCPIRegistration.PartnerProfile;

  class TestClientApi extends BaseClientApi {
    response: IRestResponse<unknown> = {
      statusCode: 200,
      result: { status_code: 1000 },
      headers: {},
    };
    getUrl(): string {
      return `https://partner.test/ocpi/emsp/2.2.1/cdrs?token=${TOKEN}`;
    }
    protected override createRaw(): Promise<IRestResponse<any>> {
      return Promise.resolve(this.response);
    }
  }

  const setup = (statusCode: number) => {
    const client = new TestClientApi();
    const logger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn() };
    (client as any).logger = logger;
    (client as any).ocpiRequestLogClient = { enabled: false };
    client.response = {
      statusCode,
      result: { status_code: 2001, status_message: `Token ${TOKEN} unknown` },
      headers: {},
    };
    const call = () =>
      client.request({
        fromCountryCode: 'MY',
        fromPartyId: 'REX',
        toCountryCode: 'MY',
        toPartyId: 'ACO',
        httpMethod: HttpMethod.Post,
        schema: z.object({ status_code: z.number() }),
        partnerProfile,
        body: { id: 'cdr-1' },
      });
    return { call, logger };
  };

  it.each([401, 403])(
    'warns once, naming partner, module and status, on HTTP %s',
    async (status) => {
      const { call, logger } = setup(status);

      await expect(call()).rejects.toThrow();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [message] = logger.warn.mock.calls[0];
      expect(message).toContain('OCPI outbound auth rejected');
      expect(message).toContain('partner=MY/ACO');
      expect(message).toContain('module=cdrs');
      expect(message).toContain(`status=${status}`);
    },
  );

  it('puts no credential in the warning', async () => {
    const { call, logger } = setup(401);

    await expect(call()).rejects.toThrow();

    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(TOKEN);
  });

  it('stays quiet for failures that are not about authentication', async () => {
    const { call, logger } = setup(500);

    await expect(call()).rejects.toThrow();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('changes nothing about the call — the same error still reaches the caller', async () => {
    const { call } = setup(401);

    await expect(call()).rejects.toMatchObject({
      name: 'UnsuccessfulRequestException',
    });
  });
});
