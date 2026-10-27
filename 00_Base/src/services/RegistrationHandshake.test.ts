// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { NotFoundError } from 'routing-controllers';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { OcpiConfig } from '../config/ocpi.types';
import { RegistrationHandshake } from './RegistrationHandshake';
import { AlreadyRegisteredException } from '../exception/AlreadyRegisteredException';
import { NotRegisteredException } from '../exception/NotRegisteredException';
import { InvalidParamException } from '../exception/InvalidParamException';
import { VersionNumber } from '../model/VersionNumber';
import { UPDATE_TENANT_PARTNER_PROFILE } from '../graphql/queries/tenant.mutations';

// Focus: the CPO-issued flow's first half. What gets persisted on the partner
// record when we mint (or withdraw) a setup token — never what the code does
// on the way there.
describe('RegistrationHandshake — setup token', () => {
  const PARTNER = {
    cpoCountryCode: 'MY',
    cpoPartyId: 'REX',
    mspCountryCode: 'MY',
    mspPartyId: 'PRK',
  };

  type Row = {
    id: number;
    tenantId: number;
    countryCode: string;
    partyId: string;
    partnerProfileOCPI: any;
    tenant: any;
  };

  const makeRow = (partnerProfileOCPI: any = null, id = 9): Row => ({
    id,
    tenantId: 1,
    countryCode: 'MY',
    partyId: 'PRK',
    partnerProfileOCPI,
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
  });

  // Stub GraphQL client: every lookup returns `rows`; profile writes are
  // recorded so tests can assert on what was persisted.
  const makeHandshake = (
    rows: Row[],
    registration: { publicBaseUrl?: string } = {
      publicBaseUrl: 'https://ocpi.example.net/ocpi',
    },
  ) => {
    const writes: Array<{ partnerId: number; input: any }> = [];
    const request = jest.fn(async (query: unknown, variables?: any) => {
      if (query === UPDATE_TENANT_PARTNER_PROFILE) {
        writes.push(variables);
        return { update_TenantPartners: { affected_rows: 1 } };
      }
      return { TenantPartners: rows };
    });
    const handshake = new RegistrationHandshake(
      { request } as unknown as OcpiGraphqlClient,
      { registration } as unknown as OcpiConfig,
      {} as any,
      {} as any,
    );
    return { handshake, writes };
  };

  describe('issueSetupToken', () => {
    it('stores a fresh token with our versions URL derived from the public base URL', async () => {
      const { handshake, writes } = makeHandshake([makeRow()]);

      const issued = await handshake.issueSetupToken(
        PARTNER,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      );

      expect(issued.versionsUrl).toBe(
        'https://ocpi.example.net/ocpi/versions/1',
      );
      expect(issued.token).toMatch(/^[0-9a-f-]{36}$/);
      expect(writes).toHaveLength(1);
      expect(writes[0].partnerId).toBe(9);
      expect(writes[0].input.serverCredentials).toEqual({
        token: issued.token,
        versionsUrl: 'https://ocpi.example.net/ocpi/versions/1',
      });
    });

    it('uses an explicit versions URL override over the derived one', async () => {
      const { handshake, writes } = makeHandshake([makeRow()]);

      const issued = await handshake.issueSetupToken(
        PARTNER,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
        'https://other-host.example.net/ocpi/versions/1',
      );

      expect(issued.versionsUrl).toBe(
        'https://other-host.example.net/ocpi/versions/1',
      );
      expect(writes[0].input.serverCredentials.versionsUrl).toBe(
        'https://other-host.example.net/ocpi/versions/1',
      );
    });

    it('merges into an existing profile, keeping the roles and version already there', async () => {
      const roles = [{ role: 'EMSP', businessDetails: { name: 'ParkIt' } }];
      const { handshake, writes } = makeHandshake([
        makeRow({ roles, version: { version: '2.2' } }),
      ]);

      await handshake.issueSetupToken(
        PARTNER,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      );

      expect(writes[0].input.roles).toEqual(roles);
      expect(writes[0].input.version).toEqual({ version: '2.2' });
      expect(writes[0].input.serverCredentials.token).toBeDefined();
    });

    it('drops leftovers the old partner form wrote — an empty credentials object and initialCredentials', async () => {
      const { handshake, writes } = makeHandshake([
        makeRow({
          credentials: { token: '', versionsUrl: '' },
          initialCredentials: { token: '', versionsUrl: '' },
          version: { version: '2.2.1' },
        }),
      ]);

      await handshake.issueSetupToken(
        PARTNER,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      );

      expect(writes[0].input.credentials).toBeUndefined();
      expect(writes[0].input.initialCredentials).toBeUndefined();
      expect(writes[0].input.version).toEqual({ version: '2.2.1' });
    });

    it('records the requested version when the profile has none', async () => {
      const { handshake, writes } = makeHandshake([makeRow()]);

      await handshake.issueSetupToken(
        PARTNER,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      );

      expect(writes[0].input.version).toEqual({
        version: VersionNumber.TWO_DOT_TWO_DOT_ONE,
      });
    });

    it('refuses a partner that already holds an issued token, without writing or echoing it', async () => {
      const held = 'held-token-00000000-0000-0000-0000-000000000000';
      const { handshake, writes } = makeHandshake([
        makeRow({ serverCredentials: { token: held, versionsUrl: 'x' } }),
      ]);

      const attempt = handshake.issueSetupToken(
        PARTNER,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      );

      await expect(attempt).rejects.toBeInstanceOf(AlreadyRegisteredException);
      await expect(attempt).rejects.not.toThrow(held);
      expect(writes).toHaveLength(0);
    });

    it('answers not-found for an unknown country code and party id', async () => {
      const { handshake, writes } = makeHandshake([]);

      const attempt = handshake.issueSetupToken(
        PARTNER,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      );

      await expect(attempt).rejects.toBeInstanceOf(NotFoundError);
      await expect(attempt).rejects.toThrow('MY/PRK');
      expect(writes).toHaveLength(0);
    });

    it('refuses when the identity matches more than one partner record', async () => {
      const { handshake, writes } = makeHandshake([
        makeRow(null, 9),
        makeRow(null, 10),
      ]);

      await expect(
        handshake.issueSetupToken(PARTNER, VersionNumber.TWO_DOT_TWO_DOT_ONE),
      ).rejects.toBeInstanceOf(InvalidParamException);
      expect(writes).toHaveLength(0);
    });

    it('refuses when no public base URL is configured and no override is given', async () => {
      const { handshake, writes } = makeHandshake([makeRow()], {});

      await expect(
        handshake.issueSetupToken(PARTNER, VersionNumber.TWO_DOT_TWO_DOT_ONE),
      ).rejects.toThrow('publicBaseUrl');
      expect(writes).toHaveLength(0);
    });
  });

  describe('cancelSetupToken', () => {
    it('withdraws an issued token and keeps the rest of the profile', async () => {
      const roles = [{ role: 'EMSP', businessDetails: { name: 'ParkIt' } }];
      const { handshake, writes } = makeHandshake([
        makeRow({
          serverCredentials: { token: 'issued', versionsUrl: 'x' },
          roles,
          version: { version: '2.2.1' },
        }),
      ]);

      await handshake.cancelSetupToken(PARTNER);

      expect(writes).toHaveLength(1);
      expect(writes[0].input.serverCredentials).toBeUndefined();
      expect(writes[0].input.roles).toEqual(roles);
      expect(writes[0].input.version).toEqual({ version: '2.2.1' });
    });

    it('refuses on a registered partnership — that needs a reset', async () => {
      const { handshake, writes } = makeHandshake([
        makeRow({
          serverCredentials: { token: 'ours', versionsUrl: 'x' },
          credentials: { token: 'theirs', versionsUrl: 'y' },
        }),
      ]);

      await expect(handshake.cancelSetupToken(PARTNER)).rejects.toBeInstanceOf(
        AlreadyRegisteredException,
      );
      expect(writes).toHaveLength(0);
    });

    it('refuses when no setup token has been issued', async () => {
      const { handshake, writes } = makeHandshake([makeRow()]);

      await expect(handshake.cancelSetupToken(PARTNER)).rejects.toBeInstanceOf(
        NotRegisteredException,
      );
      expect(writes).toHaveLength(0);
    });
  });
});
