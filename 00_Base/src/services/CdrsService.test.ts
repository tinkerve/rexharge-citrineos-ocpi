// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { CdrsService } from './CdrsService';

// Focus: a roaming partner pulling GET /cdrs gets back exactly the CDR that was
// persisted at session end (CdrRecords.cdrData) — never a CDR rebuilt from live
// transaction data and the station's current tariff.
describe('CdrsService.getCdrs serves stored CDRs', () => {
  const makeStoredCdr = (id: string, totalCost = 12.34) => ({
    country_code: 'MY',
    party_id: 'REX',
    id,
    start_date_time: '2026-08-04T14:00:00.000Z',
    end_date_time: '2026-08-04T15:00:00.000Z',
    currency: 'MYR',
    // Tariff embedded at session end; deliberately not what the station uses now.
    tariffs: [
      {
        id: 'OLD-TARIFF',
        elements: [{ price_components: [{ type: 'ENERGY', price: 1.5 }] }],
      },
    ],
    total_cost: { excl_vat: totalCost },
    last_updated: '2026-08-04T15:00:01.000Z',
  });

  type Row = { id: number; cdrId: string; cdrData: unknown };

  // Stub GraphQL client over an in-memory list: honours offset/limit like
  // Hasura does and reports the unpaged total via the aggregate.
  const makeClient = (rows: Row[]) => {
    const request = jest.fn(async (_query: string, variables?: any) => {
      const offset = variables?.offset ?? 0;
      const limit = variables?.limit ?? rows.length;
      return {
        CdrRecords: rows.slice(offset, offset + limit),
        CdrRecords_aggregate: { aggregate: { count: rows.length } },
      };
    });
    return { client: { request } as unknown as OcpiGraphqlClient, request };
  };

  it('returns each stored cdrData unchanged, whatever the current station tariff is', async () => {
    const stored = makeStoredCdr('00036');
    const { client } = makeClient([{ id: 1, cdrId: '00036', cdrData: stored }]);
    const service = new CdrsService(client);

    const first = await service.getCdrs('GT', 'GEN', 'MY', 'REX');
    const second = await service.getCdrs('GT', 'GEN', 'MY', 'REX');

    expect(first.data).toEqual([stored]);
    expect(first.data[0]).toBe(stored);
    expect(JSON.stringify(first.data)).toBe(JSON.stringify([stored]));
    expect(JSON.stringify(second.data)).toBe(JSON.stringify(first.data));
  });

  it('scopes to the requesting partner and our tenant via CdrRecords relations', async () => {
    const { client, request } = makeClient([]);
    const service = new CdrsService(client);

    await service.getCdrs('GT', 'GEN', 'MY', 'REX');

    const { where } = request.mock.calls[0][1];
    expect(where).toEqual({
      TenantPartner: { countryCode: { _eq: 'GT' }, partyId: { _eq: 'GEN' } },
      Transaction: {
        Tenant: { countryCode: { _eq: 'MY' }, partyId: { _eq: 'REX' } },
      },
    });
  });

  it('filters on the record updatedAt when bounds are given', async () => {
    const { client, request } = makeClient([]);
    const service = new CdrsService(client);
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-31T23:59:59.000Z');

    await service.getCdrs('GT', 'GEN', 'MY', 'REX', from, to);

    const { where } = request.mock.calls[0][1];
    expect(where.updatedAt).toEqual({
      _gte: from.toISOString(),
      _lte: to.toISOString(),
    });
    expect(where.Transaction.updatedAt).toBeUndefined();
  });

  it('applies only the bound that is given', async () => {
    const { client, request } = makeClient([]);
    const service = new CdrsService(client);
    const from = new Date('2026-08-01T00:00:00.000Z');

    await service.getCdrs('GT', 'GEN', 'MY', 'REX', from, undefined);

    const { where } = request.mock.calls[0][1];
    expect(where.updatedAt).toEqual({ _gte: from.toISOString() });
  });

  it('omits the date filter when no bounds are given', async () => {
    const { client, request } = makeClient([]);
    const service = new CdrsService(client);

    await service.getCdrs('GT', 'GEN', 'MY', 'REX');

    const { where } = request.mock.calls[0][1];
    expect(where).not.toHaveProperty('updatedAt');
  });

  it('orders by record id so paging is deterministic', async () => {
    const { client, request } = makeClient([]);
    const service = new CdrsService(client);

    await service.getCdrs('GT', 'GEN', 'MY', 'REX');

    const query: string = request.mock.calls[0][0];
    expect(query).toMatch(/order_by:\s*\{\s*id:\s*asc\s*\}/);
  });

  it('pages with offset/limit and reports the unpaged total, stable across calls', async () => {
    const rows: Row[] = [1, 2, 3, 4, 5].map((n) => ({
      id: n,
      cdrId: `0000${n}`,
      cdrData: makeStoredCdr(`0000${n}`),
    }));
    const { client } = makeClient(rows);
    const service = new CdrsService(client);

    const page = await service.getCdrs(
      'GT',
      'GEN',
      'MY',
      'REX',
      undefined,
      undefined,
      2,
      2,
    );
    const again = await service.getCdrs(
      'GT',
      'GEN',
      'MY',
      'REX',
      undefined,
      undefined,
      2,
      2,
    );

    expect(page.data.map((c: any) => c.id)).toEqual(['00003', '00004']);
    expect(page.total).toBe(5);
    expect(page.offset).toBe(2);
    expect(page.limit).toBe(2);
    expect(again).toEqual(page);
  });

  it('keeps the response envelope shape: data, total, offset, limit', async () => {
    const { client } = makeClient([]);
    const service = new CdrsService(client);

    const result = await service.getCdrs('GT', 'GEN', 'MY', 'REX');

    expect(Object.keys(result).sort()).toEqual([
      'data',
      'limit',
      'offset',
      'total',
    ]);
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
  });
});
