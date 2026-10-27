// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { OcpiConfig } from '../config/ocpi.types';
import { RegistrationHandshake } from './RegistrationHandshake';
import { NotRegisteredException } from '../exception/NotRegisteredException';
import { RegistrationHandshakeException } from '../exception/RegistrationHandshakeException';
import { UnsuccessfulRequestException } from '../exception/UnsuccessfulRequestException';
import { UPDATE_TENANT_PARTNER_PROFILE } from '../graphql/queries/tenant.mutations';

// Focus: rotation re-keys a working partnership in place. What is persisted
// on success, and that a rejected rotation leaves the old credentials in
// force — a failed re-key must never take a live partnership down.
describe('RegistrationHandshake — rotate', () => {
  const IDENTITY = {
    cpoCountryCode: 'MY',
    cpoPartyId: 'REX',
    mspCountryCode: 'MY',
    mspPartyId: 'PRK',
  };
  const OLD_OURS = 'old-our-token-0001';
  const OLD_THEIRS = 'old-their-token-0002';
  const REGISTERED = {
    serverCredentials: {
      token: OLD_OURS,
      versionsUrl: 'https://ocpi.example.net/ocpi/versions/1',
    },
    credentials: { token: OLD_THEIRS, versionsUrl: 'https://msp/versions' },
    roles: [{ role: 'EMSP', businessDetails: { name: 'ParkIt' } }],
    endpoints: [{ identifier: 'credentials', url: 'https://msp/cred' }],
    version: { version: '2.2.1' },
  };

  const setup = (profile: any, put?: jest.Mock, failWrites: number[] = []) =>
    setupWith(profile, put, failWrites);

  const setupWith = (
    profile: any,
    put: jest.Mock | undefined = jest.fn(async () => ({
      data: {
        token: 'new-their-token-0003',
        url: 'https://msp/versions',
        roles: [
          {
            role: 'EMSP',
            party_id: 'PRK',
            country_code: 'MY',
            business_details: { name: 'ParkIt Sdn Bhd' },
          },
        ],
      },
    })),
    failWrites: number[] = [],
  ) => {
    put ??= jest.fn(async () => ({
      data: {
        token: 'new-their-token-0003',
        url: 'https://msp/versions',
        roles: [
          {
            role: 'EMSP',
            party_id: 'PRK',
            country_code: 'MY',
            business_details: { name: 'ParkIt Sdn Bhd' },
          },
        ],
      },
    }));
    const events: string[] = [];
    const writes: any[] = [];
    let writeCount = 0;
    const request = jest.fn(async (query: unknown, variables?: any) => {
      if (
        query === UPDATE_TENANT_PARTNER_PROFILE &&
        failWrites.includes(++writeCount)
      ) {
        throw new Error('database down');
      }
      if (query === UPDATE_TENANT_PARTNER_PROFILE) {
        events.push('write');
        writes.push(structuredClone(variables.input));
        return { update_TenantPartners: { affected_rows: 1 } };
      }
      return {
        TenantPartners: [
          {
            id: 9,
            tenantId: 1,
            countryCode: 'MY',
            partyId: 'PRK',
            partnerProfileOCPI: structuredClone(profile),
            tenant: {
              id: 1,
              countryCode: 'MY',
              partyId: 'REX',
              serverProfileOCPI: {
                credentialsRole: {
                  role: 'CPO',
                  businessDetails: { name: 'Rexharge' },
                },
              },
            },
          },
        ],
      };
    });
    const sentProfiles: any[] = [];
    const credentials = {
      putCredentials: jest.fn(async (...args: any[]) => {
        events.push('put');
        sentProfiles.push(structuredClone(args[4]));
        return put!(...args);
      }),
    };
    const handshake = new RegistrationHandshake(
      { request } as unknown as OcpiGraphqlClient,
      { registration: {} } as unknown as OcpiConfig,
      {} as any,
      credentials as any,
    );
    return { handshake, events, writes, credentials, sentProfiles };
  };

  it('replaces both sides’ tokens and persists what the partner sends back', async () => {
    const { handshake, writes } = setup(REGISTERED);

    await handshake.rotate(IDENTITY);

    const final = writes[writes.length - 1];
    expect(final.serverCredentials.token).not.toBe(OLD_OURS);
    expect(final.serverCredentials.versionsUrl).toBe(
      REGISTERED.serverCredentials.versionsUrl,
    );
    expect(final.credentials).toEqual({
      token: 'new-their-token-0003',
      versionsUrl: 'https://msp/versions',
    });
    expect(final.roles[0].businessDetails.name).toBe('ParkIt Sdn Bhd');
    expect(final.endpoints).toEqual(REGISTERED.endpoints);
  });

  it('persists our new token before sending it, and authenticates with the partner’s current token', async () => {
    const { handshake, events, writes, credentials, sentProfiles } =
      setup(REGISTERED);

    await handshake.rotate(IDENTITY);

    expect(events.slice(0, 2)).toEqual(['write', 'put']);
    const [, , , , , body, overrideToken] =
      credentials.putCredentials.mock.calls[0];
    expect(sentProfiles[0].credentials.token).toBe(OLD_THEIRS);
    expect(overrideToken).toBeUndefined();
    expect(body.token).toBe(writes[0].serverCredentials.token);
  });

  it('puts the old credentials back when the partner rejects the rotation', async () => {
    const rejection = new UnsuccessfulRequestException('failed', {
      statusCode: 401,
      result: {
        status_code: 2001,
        status_message: `Token ${OLD_THEIRS} not recognised`,
      },
      headers: {},
    } as any);
    const { handshake, writes } = setup(
      REGISTERED,
      jest.fn(async () => {
        throw rejection;
      }),
    );

    const attempt = handshake.rotate(IDENTITY);

    await expect(attempt).rejects.toBeInstanceOf(
      RegistrationHandshakeException,
    );
    const error = (await attempt.catch((e: Error) => e)) as Error;
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain(OLD_THEIRS);
    expect(error.message).not.toContain(writes[0].serverCredentials.token);
    expect(writes[writes.length - 1]).toEqual(REGISTERED);
  });

  it('does not put the old credentials back once the partner has switched to new ones', async () => {
    const { handshake, writes } = setup(REGISTERED, undefined, [2, 3]);

    const error = (await handshake
      .rotate(IDENTITY)
      .catch((e: Error) => e)) as Error;

    expect(error.message).toContain('the partner accepted');
    expect(error.message).not.toContain('new-their-token-0003');
    expect(writes).toHaveLength(1);
  });

  it('gives up on a partner that never answers and says the change may have applied', async () => {
    jest.useFakeTimers();
    try {
      const { handshake, writes } = setup(
        REGISTERED,
        jest.fn(() => new Promise(() => undefined)),
      );

      const pending = handshake.rotate(IDENTITY).catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(20_000);
      const error = (await pending) as Error;

      expect(error.message).toContain('may have');
      expect(writes[writes.length - 1]).toEqual(REGISTERED);
    } finally {
      jest.useRealTimers();
    }
  });

  it('is refused on a partnership that is not registered', async () => {
    const { handshake, credentials } = setup({
      serverCredentials: { token: 'pending', versionsUrl: 'x' },
      version: { version: '2.2.1' },
    });

    await expect(handshake.rotate(IDENTITY)).rejects.toBeInstanceOf(
      NotRegisteredException,
    );
    expect(credentials.putCredentials).not.toHaveBeenCalled();
  });
});
