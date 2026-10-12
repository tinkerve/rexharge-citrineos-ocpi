// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ILogObj, Logger } from 'tslog';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { INSERT_CDR_RECORD_MUTATION } from '../graphql/queries/cdr.queries';
import { CdrMapper } from '../mapper/CdrMapper';
import { CdrsClientApi } from '../trigger/CdrsClientApi';
import { CdrBroadcaster } from './CdrBroadcaster';

// Focus: a transaction's CDR is the partner's bill — it is POSTed once. A
// session end can be signalled more than once (CitrineOS splits a stop across
// two Transactions updates), so the broadcaster refuses a transaction that
// already has a stored CdrRecords row or a broadcast still in flight.
describe('CdrBroadcaster.broadcastPostCdr idempotency', () => {
  const transaction = {
    id: 52,
    authorization: {
      tenantPartner: {
        id: 7,
        countryCode: 'MY',
        partyId: 'GEN',
        partnerProfileOCPI: {},
      },
    },
  } as any;

  const cdr = {
    id: 'CDR-52',
    country_code: 'MY',
    party_id: 'REX',
    start_date_time: '2026-10-12T09:00:00.000Z',
    end_date_time: '2026-10-12T10:00:00.000Z',
    currency: 'MYR',
    total_energy: 5,
    total_time: 1,
    total_cost: { excl_vat: 1 },
  };

  const setup = (existingTransactionIds: number[] = []) => {
    const stored = [...existingTransactionIds];
    const graphql = jest.fn(async (query: string, variables: any) => {
      if (query === INSERT_CDR_RECORD_MUTATION) {
        stored.push(variables.transactionId);
        return { insert_CdrRecords_one: { id: 1, cdrId: variables.cdrId } };
      }
      return {
        CdrRecords: stored
          .filter((id) => id === variables.transactionId)
          .map((id) => ({ id, cdrId: `CDR-${id}` })),
      };
    });
    const partnerPost = jest.fn(
      () => new Promise((resolve) => setTimeout(resolve, 5)),
    );
    const broadcaster = new CdrBroadcaster(
      new Logger<ILogObj>({ type: 'hidden' }),
      { mapTransactionsToCdrs: async () => [cdr] } as unknown as CdrMapper,
      { request: partnerPost } as unknown as CdrsClientApi,
      { request: graphql } as unknown as OcpiGraphqlClient,
    );
    const inserts = () =>
      graphql.mock.calls.filter(([q]) => q === INSERT_CDR_RECORD_MUTATION);
    return { broadcaster, partnerPost, inserts };
  };

  it('posts and persists the CDR when the transaction has no stored record', async () => {
    const s = setup();

    await s.broadcaster.broadcastPostCdr(transaction);

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.inserts()).toHaveLength(1);
  });

  it('skips the partner POST and the insert when a CdrRecords row already exists', async () => {
    const s = setup([52]);

    await s.broadcaster.broadcastPostCdr(transaction);

    expect(s.partnerPost).not.toHaveBeenCalled();
    expect(s.inserts()).toHaveLength(0);
  });

  it('posts once when the same transaction is broadcast twice in sequence', async () => {
    const s = setup();

    await s.broadcaster.broadcastPostCdr(transaction);
    await s.broadcaster.broadcastPostCdr(transaction);

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
  });

  it('posts once when the same transaction is broadcast concurrently', async () => {
    const s = setup();

    await Promise.all([
      s.broadcaster.broadcastPostCdr(transaction),
      s.broadcaster.broadcastPostCdr(transaction),
    ]);

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.inserts()).toHaveLength(1);
  });
});
