// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { OcpiConfig } from '../config/ocpi.types';
import { RegistrationHandshake } from './RegistrationHandshake';
import {
  CLEAR_TENANT_PARTNER_PROFILE,
  UPDATE_TENANT_PARTNER_PROFILE,
} from '../graphql/queries/tenant.mutations';
import { GET_TENANT_PARTNER_BY_CPO_AND_AND_CLIENT } from '../graphql/queries/tenantPartner.queries';

// Focus: reset puts a partnership back to "not started" on the same record.
// The partner is told first, but a partner who cannot be reached never
// wedges our record. Nothing but the OCPI profile is touched.
describe('RegistrationHandshake — reset', () => {
  const IDENTITY = {
    cpoCountryCode: 'MY',
    cpoPartyId: 'REX',
    mspCountryCode: 'MY',
    mspPartyId: 'PRK',
  };
  const PARTNER_TOKEN = 'partner-final-token-0002';
  const REGISTERED = {
    serverCredentials: { token: 'ours', versionsUrl: 'x' },
    credentials: { token: PARTNER_TOKEN, versionsUrl: 'https://msp/versions' },
    endpoints: [{ identifier: 'credentials', url: 'https://msp/cred' }],
    version: { version: '2.2.1' },
  };

  const setup = (profile: any, deleteCredentials: jest.Mock) => {
    const events: string[] = [];
    const queries: unknown[] = [];
    const request = jest.fn(async (query: unknown) => {
      queries.push(query);
      if (query === CLEAR_TENANT_PARTNER_PROFILE) {
        events.push('clear');
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
          },
        ],
      };
    });
    const credentials = {
      deleteCredentials: jest.fn(async (...args: any[]) => {
        events.push('notify');
        return deleteCredentials(...args);
      }),
    };
    const handshake = new RegistrationHandshake(
      { request } as unknown as OcpiGraphqlClient,
      { registration: {} } as unknown as OcpiConfig,
      {} as any,
      credentials as any,
    );
    return { handshake, events, queries, credentials };
  };

  it('tells a registered partner first, then clears our side', async () => {
    const { handshake, events, credentials } = setup(
      REGISTERED,
      jest.fn(async () => ({ status_code: 1000 })),
    );

    const outcome = await handshake.reset(IDENTITY);

    expect(events).toEqual(['notify', 'clear']);
    expect(outcome).toEqual({ partnerNotified: true });
    const [, , , , profile] = credentials.deleteCredentials.mock.calls[0];
    expect(profile.credentials.token).toBe(PARTNER_TOKEN);
  });

  it('still clears our side when the partner cannot be reached, and says why', async () => {
    const { handshake, events } = setup(
      REGISTERED,
      jest.fn(async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        });
      }),
    );

    const outcome = await handshake.reset(IDENTITY);

    expect(events).toEqual(['notify', 'clear']);
    expect(outcome).toEqual({
      partnerNotified: false,
      reason: 'Could not reach the partner (ECONNREFUSED)',
    });
  });

  it('does not wait forever on a partner that never answers', async () => {
    jest.useFakeTimers();
    try {
      const { handshake, events } = setup(
        REGISTERED,
        jest.fn(() => new Promise(() => undefined)),
      );

      const pending = handshake.reset(IDENTITY);
      await jest.advanceTimersByTimeAsync(15_000);
      const outcome = await pending;

      expect(events).toEqual(['notify', 'clear']);
      expect(outcome.partnerNotified).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears without calling out when we hold no token of theirs', async () => {
    const { handshake, events } = setup(
      { version: { version: '2.2.1' } },
      jest.fn(),
    );

    const outcome = await handshake.reset(IDENTITY);

    expect(events).toEqual(['clear']);
    expect(outcome).toEqual({ partnerNotified: false });
  });

  it('touches nothing but the OCPI profile — driver authorizations are left alone', async () => {
    const { handshake, queries } = setup(
      REGISTERED,
      jest.fn(async () => ({ status_code: 1000 })),
    );

    await handshake.reset(IDENTITY);

    expect(queries).toEqual([
      GET_TENANT_PARTNER_BY_CPO_AND_AND_CLIENT,
      CLEAR_TENANT_PARTNER_PROFILE,
    ]);
    expect(queries).not.toContain(UPDATE_TENANT_PARTNER_PROFILE);
  });

  it('never puts the partner’s token in the reason', async () => {
    const { handshake } = setup(
      REGISTERED,
      jest.fn(async () => {
        throw new Error(`Token ${PARTNER_TOKEN} rejected`);
      }),
    );

    const outcome = await handshake.reset(IDENTITY);

    expect(outcome.reason).not.toContain(PARTNER_TOKEN);
  });
});
