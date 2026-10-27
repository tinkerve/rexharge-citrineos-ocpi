// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { OcpiConfig } from '../config/ocpi.types';
import {
  RegistrationHandshake,
  RegistrationHandshakeException,
} from './RegistrationHandshake';
import { AlreadyRegisteredException } from '../exception/AlreadyRegisteredException';
import { UnsuccessfulRequestException } from '../exception/UnsuccessfulRequestException';
import { VersionNumber } from '../model/VersionNumber';
import {
  CLEAR_TENANT_PARTNER_PROFILE,
  UPDATE_TENANT_PARTNER_PROFILE,
} from '../graphql/queries/tenant.mutations';

// Focus: the MSP-issued flow. What ends up persisted on the partner record —
// above all the token the partner hands back — and what an admin is told when
// the partner says no.
describe('RegistrationHandshake — MSP-issued registration', () => {
  const IDENTITY = {
    cpoCountryCode: 'MY',
    cpoPartyId: 'REX',
    mspCountryCode: 'MY',
    mspPartyId: 'PRK',
  };
  const SETUP_TOKEN = 'partner-setup-token-0001';
  const PARTNER_VERSIONS = 'https://msp.example.net/ocpi/versions';
  const RETURNED_TOKEN = 'partner-final-token-0002';
  const ENDPOINTS = [
    { identifier: 'credentials', role: 'RECEIVER', url: 'https://msp/cred' },
    { identifier: 'locations', role: 'RECEIVER', url: 'https://msp/loc' },
  ];

  const OUR_SERVER_PROFILE = {
    credentialsRole: { role: 'CPO', businessDetails: { name: 'Rexharge' } },
  };

  const makeRow = (
    partnerProfileOCPI: any,
    serverProfileOCPI: any = OUR_SERVER_PROFILE,
  ) => ({
    id: 9,
    tenantId: 1,
    countryCode: 'MY',
    partyId: 'PRK',
    partnerProfileOCPI,
    tenant: {
      id: 1,
      countryCode: 'MY',
      partyId: 'REX',
      serverProfileOCPI,
    },
  });

  const setup = (
    profile: any,
    post: jest.Mock = jest.fn(async () => ({
      data: {
        token: RETURNED_TOKEN,
        url: 'https://msp.example.net/ocpi/versions',
        roles: [
          {
            role: 'EMSP',
            party_id: 'PRK',
            country_code: 'MY',
            business_details: { name: 'ParkIt' },
          },
        ],
      },
    })),
    getVersions: jest.Mock = jest.fn(async () => ({
      data: [{ version: '2.2.1', url: 'https://msp/versions/2.2.1' }],
    })),
    failWriteNumber?: number | number[],
    serverProfileOCPI: any = OUR_SERVER_PROFILE,
  ) => {
    const failing = ([] as number[]).concat(failWriteNumber ?? []);
    const events: string[] = [];
    const writes: any[] = [];
    let writeCount = 0;
    const request = jest.fn(async (query: unknown, variables?: any) => {
      if (
        (query === UPDATE_TENANT_PARTNER_PROFILE ||
          query === CLEAR_TENANT_PARTNER_PROFILE) &&
        failing.includes(++writeCount)
      ) {
        throw new Error('database down');
      }
      if (query === UPDATE_TENANT_PARTNER_PROFILE) {
        // Mirrors Hasura: the profile argument is declared non-null.
        if (variables.input == null)
          throw new Error('expected jsonb!, got null');
        events.push('write');
        writes.push(structuredClone(variables.input));
        return { update_TenantPartners: { affected_rows: 1 } };
      }
      if (query === CLEAR_TENANT_PARTNER_PROFILE) {
        events.push('write');
        writes.push(null);
        return { update_TenantPartners: { affected_rows: 1 } };
      }
      return {
        TenantPartners: [
          makeRow(structuredClone(profile), structuredClone(serverProfileOCPI)),
        ],
      };
    });
    const versions = {
      getVersions,
      getVersionDetails: jest.fn(async () => ({
        data: { version: '2.2.1', endpoints: ENDPOINTS },
      })),
    };
    const credentials = {
      postCredentials: jest.fn(async (...args: any[]) => {
        events.push('post');
        return post(...args);
      }),
    };
    const handshake = new RegistrationHandshake(
      { request } as unknown as OcpiGraphqlClient,
      {
        registration: { publicBaseUrl: 'https://ocpi.example.net/ocpi' },
      } as unknown as OcpiConfig,
      versions as any,
      credentials as any,
    );
    const complete = () =>
      handshake.completeFromPartnerToken(
        IDENTITY,
        { token: SETUP_TOKEN, url: PARTNER_VERSIONS },
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      );
    return { complete, writes, events, versions, credentials };
  };

  it('persists the token the partner returns before reporting success', async () => {
    const { complete, writes, events } = setup(null);

    await complete();

    const final = writes[writes.length - 1];
    expect(final.credentials).toEqual({
      token: RETURNED_TOKEN,
      versionsUrl: 'https://msp.example.net/ocpi/versions',
    });
    expect(events[events.length - 1]).toBe('write');
  });

  it('never keeps the partner’s setup token once they have answered', async () => {
    const { complete, writes } = setup(null);

    await complete();

    expect(JSON.stringify(writes[writes.length - 1])).not.toContain(
      SETUP_TOKEN,
    );
  });

  it('stores the endpoints and roles the partner published', async () => {
    const { complete, writes } = setup(null);

    await complete();

    const final = writes[writes.length - 1];
    expect(final.endpoints.map((e: any) => e.url)).toEqual([
      'https://msp/cred',
      'https://msp/loc',
    ]);
    expect(final.roles[0].businessDetails.name).toBe('ParkIt');
  });

  it('persists our new token before posting it, so the partner can call back during the exchange', async () => {
    const { complete, writes, events, credentials } = setup(null);

    await complete();

    expect(events.slice(0, 2)).toEqual(['write', 'post']);
    const ours = writes[0].serverCredentials;
    expect(ours.versionsUrl).toBe('https://ocpi.example.net/ocpi/versions/1');
    const [, , , , , body, overrideToken] =
      credentials.postCredentials.mock.calls[0];
    expect(body.token).toBe(ours.token);
    expect(overrideToken).toBe(SETUP_TOKEN);
  });

  it('works for a partner created with no OCPI profile', async () => {
    const { complete, writes } = setup(null);

    await complete();

    expect(writes[writes.length - 1].version.version).toBe('2.2.1');
  });

  it('restores the record and reports a redacted reason when the partner rejects the exchange', async () => {
    const before = { version: { version: '2.2.1' } };
    const rejection = new UnsuccessfulRequestException('failed', {
      statusCode: 401,
      result: {
        status_code: 2001,
        status_message: `Token ${SETUP_TOKEN} is unknown`,
      },
      headers: {},
    } as any);
    const { complete, writes } = setup(
      before,
      jest.fn(async () => {
        throw rejection;
      }),
    );

    const attempt = complete();

    await expect(attempt).rejects.toBeInstanceOf(
      RegistrationHandshakeException,
    );
    const error = (await attempt.catch((e: Error) => e)) as Error;
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain(SETUP_TOKEN);
    expect(error.message).not.toContain(writes[0].serverCredentials.token);
    expect(writes[writes.length - 1]).toEqual(before);
  });

  it('restores a partner that had no profile back to having none', async () => {
    const rejection = new UnsuccessfulRequestException('failed', {
      statusCode: 401,
      result: { status_code: 2001, status_message: 'Unknown token' },
      headers: {},
    } as any);
    const { complete, writes } = setup(
      null,
      jest.fn(async () => {
        throw rejection;
      }),
    );

    await expect(complete()).rejects.toThrow('HTTP 401');
    expect(writes[writes.length - 1]).toBeNull();
  });

  it('says so when the record could not be restored after a failure', async () => {
    const rejection = new UnsuccessfulRequestException('failed', {
      statusCode: 401,
      result: { status_code: 2001, status_message: 'Unknown token' },
      headers: {},
    } as any);
    // Write 1 persists our token; write 2 is the restore, which fails.
    const { complete } = setup(
      { version: { version: '2.2.1' } },
      jest.fn(async () => {
        throw rejection;
      }),
      undefined,
      2,
    );

    await expect(complete()).rejects.toThrow(
      'Partner answered HTTP 401: Unknown token (OCPI 2001); our record could not be put back',
    );
  });

  it('keeps — never rolls back — once the partner has answered with its token, retrying the save', async () => {
    // Write 1: our token. Write 2: the partner's answer (fails once).
    const { complete, writes } = setup(null, undefined, undefined, 2);

    await complete();

    expect(writes[writes.length - 1].credentials.token).toBe(RETURNED_TOKEN);
  });

  it('does not restore after the partner accepted, if saving their answer keeps failing', async () => {
    const { complete, writes } = setup(null, undefined, undefined, [2, 3]);

    const error = (await complete().catch((e: Error) => e)) as Error;

    expect(error).toBeInstanceOf(RegistrationHandshakeException);
    expect(error.message).toContain('the partner accepted');
    expect(error.message).not.toContain(RETURNED_TOKEN);
    expect(writes).toHaveLength(1); // only our token; nothing put back
  });

  it('gives up on a partner that never answers, restores, and says the partner may have applied it', async () => {
    jest.useFakeTimers();
    try {
      const { complete, writes } = setup(
        null,
        jest.fn(() => new Promise(() => undefined)),
      );

      const pending = complete().catch((e: Error) => e);
      await jest.advanceTimersByTimeAsync(20_000);
      const error = (await pending) as Error;

      expect(error.message).toContain('ETIMEDOUT');
      expect(error.message).toContain('may have');
      expect(writes[writes.length - 1]).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops before writing or calling the partner when our own server profile is missing', async () => {
    const { complete, writes, credentials } = setup(
      null,
      undefined,
      undefined,
      undefined,
      null,
    );

    const error = await complete().catch((e) => e);

    expect(error).toBeInstanceOf(RegistrationHandshakeException);
    expect(error.message).toMatch(/server profile/i);
    expect(error.message).not.toMatch(/may have applied/);
    expect(writes).toEqual([]);
    expect(credentials.postCredentials).not.toHaveBeenCalled();
  });

  it('writes nothing when the partner cannot even be reached', async () => {
    const unreachable = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const { complete, writes } = setup(
      null,
      undefined,
      jest.fn(async () => {
        throw unreachable;
      }),
    );

    await expect(complete()).rejects.toThrow(
      'Could not reach the partner (ECONNREFUSED)',
    );
    expect(writes).toHaveLength(0);
  });

  it('refuses a partnership that is already registered, without calling the partner', async () => {
    const { complete, versions } = setup({
      serverCredentials: { token: 'ours', versionsUrl: 'x' },
      credentials: { token: 'theirs', versionsUrl: 'y' },
      version: { version: '2.2.1' },
    });

    await expect(complete()).rejects.toBeInstanceOf(AlreadyRegisteredException);
    expect(versions.getVersions).not.toHaveBeenCalled();
  });

  it('proceeds over a leftover partner-token field with no token of ours — a half-written old record', async () => {
    const { complete, writes } = setup({
      credentials: { token: 'pasted-long-ago', versionsUrl: 'x' },
      version: { version: '2.2.1' },
    });

    await complete();

    expect(writes[writes.length - 1].credentials.token).toBe(RETURNED_TOKEN);
  });

  it('refuses while a setup token we issued is still pending — that is the other flow', async () => {
    const { complete, versions } = setup({
      serverCredentials: { token: 'pending', versionsUrl: 'x' },
      version: { version: '2.2.1' },
    });

    await expect(complete()).rejects.toBeInstanceOf(AlreadyRegisteredException);
    expect(versions.getVersions).not.toHaveBeenCalled();
  });
});
