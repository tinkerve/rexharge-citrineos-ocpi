// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { NotFoundError } from 'routing-controllers';
import { CredentialsService } from './CredentialsService';
import { AlreadyRegisteredException } from '../exception/AlreadyRegisteredException';
import { VersionNumber } from '../model/VersionNumber';

// Focus: an MSP calling in on a setup token we minted. A leftover, empty
// credentials object from the old partner form must not turn them away.
describe('CredentialsService.postCredentials — partner calls in', () => {
  const makePartner = (credentials: any) => ({
    id: 9,
    countryCode: 'MY',
    partyId: 'PRK',
    tenant: {
      countryCode: 'MY',
      partyId: 'REX',
      serverProfileOCPI: {
        credentialsRole: { role: 'CPO', businessDetails: { name: 'Rexharge' } },
        versionDetails: [
          { version: '2.2', versionDetailsUrl: 'https://us/versions/1/2.2' },
          { version: '2.2.1', versionDetailsUrl: 'https://us/versions/1/2.2.1' },
        ],
      },
    },
    partnerProfileOCPI: {
      version: { version: '2.2.1' },
      serverCredentials: {
        token: 'setup',
        versionsUrl: 'https://us/versions/1',
      },
      ...(credentials === undefined ? {} : { credentials }),
    },
  });

  const graphql = { request: jest.fn(async (..._args: unknown[]) => ({})) };
  const makeService = () =>
    new CredentialsService(
      { info: jest.fn(), warn: jest.fn(), debug: jest.fn() } as any,
      graphql as any,
      {
        getVersions: jest.fn(async () => ({
          data: [
            { version: '2.2', url: 'https://msp/versions/2.2' },
            { version: '2.2.1', url: 'https://msp/versions/2.2.1' },
          ],
        })),
        getVersionDetails: jest.fn(async () => ({
          data: { version: '2.2.1', endpoints: [] },
        })),
      } as any,
      {} as any,
    );

  const body = {
    token: 'their-token',
    url: 'https://msp/versions',
    roles: [
      {
        role: 'EMSP',
        party_id: 'PRK',
        country_code: 'MY',
        business_details: { name: 'ParkIt' },
      },
    ],
  } as any;

  it('accepts a partner whose record carries an empty leftover credentials object', async () => {
    await expect(
      makeService().postCredentials(
        makePartner({ token: '', versionsUrl: '' }) as any,
        body,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      ),
    ).resolves.toMatchObject({ url: 'https://us/versions/1' });
  });

  it('still refuses a partner that already holds a token of theirs', async () => {
    await expect(
      makeService().postCredentials(
        makePartner({ token: 'existing', versionsUrl: 'x' }) as any,
        body,
        VersionNumber.TWO_DOT_TWO_DOT_ONE,
      ),
    ).rejects.toBeInstanceOf(AlreadyRegisteredException);
  });

  // The version is the partner's choice among those we advertise, not the one
  // fixed when the setup token was issued: after a reset the token is minted
  // with a default the partner may not speak.
  it('accepts a partner choosing another version we advertise, and records it', async () => {
    graphql.request.mockClear();

    await expect(
      makeService().postCredentials(
        makePartner(undefined) as any,
        body,
        VersionNumber.TWO_DOT_TWO,
      ),
    ).resolves.toMatchObject({ url: 'https://us/versions/1' });

    const written = (graphql.request.mock.calls[0][1] as any).input;
    expect(written.version).toEqual({
      version: '2.2',
      versionDetailsUrl: 'https://msp/versions/2.2',
    });
  });

  it('refuses a version we do not advertise', async () => {
    await expect(
      makeService().postCredentials(
        makePartner(undefined) as any,
        body,
        VersionNumber.TWO_DOT_ONE_DOT_ONE,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
