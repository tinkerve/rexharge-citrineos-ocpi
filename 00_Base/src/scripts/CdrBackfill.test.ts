// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { join } from 'path';
import { ILogObj, Logger } from 'tslog';
import { CdrBroadcaster } from '../broadcaster/CdrBroadcaster';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import {
  GET_AUTHORIZATION_BY_ID,
  GET_LOCATION_BY_ID_QUERY,
  GET_STATUS_NOTIFICATIONS_IN_RANGE,
  GET_TARIFF_BY_KEY_QUERY,
  INSERT_CDR_RECORD_MUTATION,
} from '../graphql';
import {
  GET_CDR_BACKFILL_CANDIDATES_QUERY,
  INSERT_CDR_RECORD_IF_ABSENT_MUTATION,
} from '../graphql/queries/cdr.queries';
import { CdrMapper } from '../mapper/CdrMapper';
import { SessionMapper } from '../mapper/SessionMapper';
import { Cdr } from '../model/Cdr';
import { LocationsService } from '../services/LocationsService';
import { CdrsClientApi } from '../trigger/CdrsClientApi';
import {
  CdrBackfill,
  ConfirmedTariffs,
  formatBackfillReport,
} from './CdrBackfill';

// Focus: the backfill repairs missing CdrRecords rows without ever pricing a
// CDR with today's tariff, without touching existing rows, and without sending
// anything to a partner. The GraphQL client is stubbed over in-memory tables;
// the mapper is the real one so price assertions hold end to end.
describe('CdrBackfill', () => {
  const CURRENT_PRICE = 0.5; // what the station charges today
  const CONFIRMED_PRICE = 0.1; // what a human confirmed applied at session time

  const partner = {
    id: 7,
    countryCode: 'GT',
    partyId: 'GEN',
    partnerProfileOCPI: {},
  };

  const makeTransaction = (
    id: number,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    stationId: '55102-001',
    transactionId: `tx-${id}`,
    isActive: false,
    timeSpentCharging: 3600,
    totalKwh: 13.5,
    startTime: '2026-08-27T10:00:00.000Z',
    endTime: '2026-08-27T11:00:00.000Z',
    createdAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T11:00:05.000Z',
    evseId: 1,
    connectorId: 1,
    locationId: 3,
    authorizationId: 9,
    tariffId: 66,
    tenantId: 1,
    customData: null,
    tenant: { countryCode: 'MY', partyId: 'REX' },
    authorization: { tenantPartner: partner, idToken: 'TOKEN-1' },
    transactionEvents: [],
    meterValues: [
      { timestamp: '2026-08-27T10:00:30.000Z', sampledValue: wh(1000000) },
      { timestamp: '2026-08-27T10:30:00.000Z', sampledValue: wh(1006750) },
      { timestamp: '2026-08-27T11:00:00.000Z', sampledValue: wh(1013500) },
    ],
    ...overrides,
  });

  function wh(value: number) {
    return [
      {
        value: String(value),
        context: 'Sample.Periodic',
        measurand: 'Energy.Active.Import.Register',
        unit: 'Wh',
      },
    ];
  }

  type StoredRecord = {
    id: number;
    cdrId: string;
    transactionId: number | null;
    cdrData: unknown;
  };

  const makeWorld = (opts: {
    transactions: Record<string, unknown>[];
    records?: StoredRecord[];
  }) => {
    const records: StoredRecord[] = [...(opts.records ?? [])];
    const inserts: Record<string, any>[] = [];
    const requests: { query: string; variables: any }[] = [];

    const page = <T>(rows: T[], vars: any): T[] =>
      rows.slice(
        vars?.offset ?? 0,
        (vars?.offset ?? 0) + (vars?.limit ?? rows.length),
      );

    const request = jest.fn(async (query: string, variables?: any) => {
      requests.push({ query, variables });
      switch (query) {
        case GET_CDR_BACKFILL_CANDIDATES_QUERY: {
          // Deliberately naive about isActive / Authorization, so the class
          // must filter active and non-roaming rows itself. It does honour
          // `_not: { CdrRecord: {} }`, as Hasura would.
          const linked = new Set(records.map((r) => r.transactionId));
          const rows = variables.where?._not?.CdrRecord
            ? opts.transactions.filter((t) => !linked.has(t.id as number))
            : opts.transactions;
          return { Transactions: page(rows, variables) };
        }
        case GET_LOCATION_BY_ID_QUERY:
          return {
            Locations: [
              {
                id: 3,
                name: 'Depot',
                address: '1 Road',
                city: 'KL',
                postalCode: '50000',
                country: 'MYS',
                timeZone: 'Asia/Kuala_Lumpur',
                updatedAt: '2026-01-01T00:00:00.000Z',
                coordinates: { coordinates: [3.1, 101.6] },
                tenant: { countryCode: 'MY', partyId: 'REX' },
              },
            ],
          };
        case GET_AUTHORIZATION_BY_ID:
          return {
            Authorizations_by_pk: {
              id: 9,
              idToken: 'TOKEN-1',
              status: 'Accepted',
              additionalInfo: [
                { type: 'eMAID', additionalIdToken: 'MY-REX-C000001-A' },
                { type: 'visual_number', additionalIdToken: '0001' },
                { type: 'issuer', additionalIdToken: 'Gentari' },
              ],
              updatedAt: '2026-08-01T00:00:00.000Z',
              tenantPartner: partner,
            },
          };
        case GET_TARIFF_BY_KEY_QUERY:
          // The station's CURRENT tariff — the one a backfill must not use.
          return {
            Tariffs: [
              {
                id: 66,
                currency: 'MYR',
                pricePerKwh: CURRENT_PRICE,
                pricePerMin: null,
                pricePerSession: null,
                taxRate: null,
                stationId: '55102-001',
                updatedAt: '2026-10-01T00:00:00.000Z',
                tenant: { countryCode: 'MY', partyId: 'REX' },
              },
            ],
          };
        case GET_STATUS_NOTIFICATIONS_IN_RANGE:
          return { StatusNotifications: [] };
        case INSERT_CDR_RECORD_IF_ABSENT_MUTATION: {
          inserts.push(variables);
          // ON CONFLICT DO NOTHING: an existing cdrId is left untouched.
          if (records.some((r) => r.cdrId === variables.cdrId)) {
            return { insert_CdrRecords_one: null };
          }
          const row = {
            id: records.length + 1,
            cdrId: variables.cdrId,
            transactionId: variables.transactionId ?? null,
            cdrData: variables.cdrData,
          };
          records.push(row);
          return { insert_CdrRecords_one: { id: row.id, cdrId: row.cdrId } };
        }
        default:
          throw new Error(`Unexpected GraphQL operation:\n${query}`);
      }
    });

    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    } as unknown as Logger<ILogObj>;
    const client = { request } as unknown as OcpiGraphqlClient;
    const locations = {} as LocationsService;
    const mapper = new CdrMapper(
      logger,
      locations,
      client,
      new SessionMapper(logger, locations, client),
    );
    const backfill = new CdrBackfill(logger, client, mapper);
    return { backfill, records, inserts, requests, request, client };
  };

  const confirmed52: ConfirmedTariffs = {
    '52': { pricePerKwh: CONFIRMED_PRICE },
  };

  describe('candidate discovery', () => {
    it('lists completed roaming transactions with no CdrRecords row, and nothing else', async () => {
      const world = makeWorld({
        transactions: [
          makeTransaction(52), // missing: should be listed
          makeTransaction(53), // already has a row by transactionId
          makeTransaction(54, { isActive: true }), // still charging
          makeTransaction(55, { authorization: null }), // not roaming
          makeTransaction(56, {
            authorization: { idToken: 'APP', tenantPartner: null },
          }), // not roaming
        ],
        records: [
          { id: 1, cdrId: 'CDR**REX**00053', transactionId: 53, cdrData: {} },
        ],
      });

      const report = await world.backfill.run({
        confirmedTariffs: {},
        write: false,
      });

      expect(report.entries.map((e) => e.transactionId)).toEqual([52]);
      expect(report.entries[0].cdrId).toBe('CDR**REX**00052');
      expect(report.entries[0].cdr?.total_energy).toBe(13.5);
    });

    it('leaves an existing row alone when its cdrId is already stored without a transactionId link', async () => {
      const world = makeWorld({
        transactions: [makeTransaction(52)],
        records: [
          { id: 1, cdrId: 'CDR**REX**00052', transactionId: null, cdrData: {} },
        ],
      });

      const report = await world.backfill.run({
        confirmedTariffs: confirmed52,
        write: true,
      });

      expect(report.entries[0].status).toBe('ALREADY_EXISTS');
      expect(report.entries[0].tariffSource).toBeUndefined();
      expect(world.records).toHaveLength(1);
      expect(world.records[0].cdrData).toEqual({});
    });

    it('asks the query for completed, partner-authorised transactions only', async () => {
      const world = makeWorld({ transactions: [] });

      await world.backfill.run({ confirmedTariffs: {}, write: false });

      const call = world.requests.find(
        (r) => r.query === GET_CDR_BACKFILL_CANDIDATES_QUERY,
      )!;
      expect(call.variables.where.isActive).toEqual({ _eq: false });
      expect(call.variables.where.Authorization.TenantPartner).toBeDefined();
      // Only real gaps come back: transactions with a CdrRecord are excluded server-side.
      expect(call.variables.where._not).toEqual({ CdrRecord: {} });
    });

    it('pages through every candidate, not just the first page', async () => {
      const transactions = Array.from({ length: 205 }, (_, i) =>
        makeTransaction(100 + i),
      );
      const world = makeWorld({ transactions });

      const report = await world.backfill.run({
        confirmedTariffs: {},
        write: false,
      });

      expect(report.entries).toHaveLength(205);
      expect(report.entries[204].transactionId).toBe(304);
    });
  });

  describe('dry run', () => {
    it('shows the CDR it would insert, flags unconfirmed tariffs, and writes nothing', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      const report = await world.backfill.run({
        confirmedTariffs: {},
        write: false,
      });

      const entry = report.entries[0];
      expect(entry.status).toBe('UNCONFIRMED');
      expect(entry.tariffSource).toBe('UNCONFIRMED (current tariff)');
      // Shown priced with today's tariff so the human can see the difference...
      expect(entry.cdr?.total_cost.excl_vat).toBe(6.75);
      // ...but never persisted.
      expect(world.inserts).toHaveLength(0);
    });

    it('shows a confirmed candidate as WOULD_WRITE with the confirmed price, still writing nothing', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      const report = await world.backfill.run({
        confirmedTariffs: confirmed52,
        write: false,
      });

      expect(report.entries[0].status).toBe('WOULD_WRITE');
      expect(report.entries[0].tariffSource).toBe('CONFIRMED');
      expect(report.entries[0].cdr?.total_cost.excl_vat).toBe(1.35);
      expect(world.inserts).toHaveLength(0);
    });
  });

  describe('write mode', () => {
    it('never writes an unconfirmed candidate', async () => {
      const world = makeWorld({
        transactions: [makeTransaction(52), makeTransaction(60)],
      });

      const report = await world.backfill.run({
        confirmedTariffs: { '60': { pricePerKwh: CONFIRMED_PRICE } },
        write: true,
      });

      expect(world.inserts.map((v) => v.transactionId)).toEqual([60]);
      expect(report.entries.find((e) => e.transactionId === 52)?.status).toBe(
        'UNCONFIRMED',
      );
      expect(world.records.map((r) => r.transactionId)).toEqual([60]);
    });

    it('writes a confirmed candidate priced with the confirmed tariff, not the current one', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      const report = await world.backfill.run({
        confirmedTariffs: confirmed52,
        write: true,
      });

      expect(report.entries[0].status).toBe('WRITTEN');
      expect(world.inserts).toHaveLength(1);
      const cdr = world.inserts[0].cdrData as Cdr;
      expect(cdr.id).toBe('CDR**REX**00052');
      const energy = cdr.tariffs![0].elements[0].price_components[0];
      expect(energy.type).toBe('ENERGY');
      expect(energy.price).toBe(CONFIRMED_PRICE);
      expect(cdr.tariffs![0].id).toBe('66');
      expect(cdr.currency).toBe('MYR');
      expect(cdr.total_cost.excl_vat).toBe(1.35);
      expect(cdr.total_energy_cost?.excl_vat).toBe(1.35);
      expect(world.inserts[0].totalCostExclVat).toBe(1.35);
    });

    it('carries confirmed time, session fee and tax into the CDR', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      await world.backfill.run({
        confirmedTariffs: {
          '52': {
            pricePerKwh: 0.1,
            pricePerMin: 0.01,
            pricePerSession: 1,
            taxRate: 0.06,
            currency: 'SGD',
          },
        },
        write: true,
      });

      const cdr = world.inserts[0].cdrData as Cdr;
      expect(cdr.currency).toBe('SGD');
      const types = cdr.tariffs![0].elements.flatMap((e) =>
        e.price_components.map((pc) => pc.type),
      );
      expect(types).toEqual(expect.arrayContaining(['ENERGY', 'TIME', 'FLAT']));
      expect(cdr.total_cost.incl_vat).toBeGreaterThan(cdr.total_cost.excl_vat);
    });

    it('uses the same column mapping as the broadcaster persists', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });
      await world.backfill.run({ confirmedTariffs: confirmed52, write: true });
      const backfilled = world.inserts[0];

      // Drive the real broadcaster with the very same CDR and capture what it persists.
      const broadcasterRequest = jest.fn().mockResolvedValue({});
      const broadcaster = new CdrBroadcaster(
        {
          debug: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
        } as unknown as Logger<ILogObj>,
        {
          mapTransactionsToCdrs: async () => [backfilled.cdrData],
        } as unknown as CdrMapper,
        {
          request: jest.fn().mockResolvedValue({}),
        } as unknown as CdrsClientApi,
        { request: broadcasterRequest } as unknown as OcpiGraphqlClient,
      );
      await broadcaster.broadcastPostCdr(makeTransaction(52) as any);
      const [, persisted] = broadcasterRequest.mock.calls.find(
        ([query]) => query === INSERT_CDR_RECORD_MUTATION,
      )!;

      const strip = (vars: Record<string, unknown>) => ({
        ...vars,
        createdAt: undefined,
        updatedAt: undefined,
      });
      expect(strip(backfilled)).toEqual(strip(persisted));
      expect(backfilled.tenantPartnerId).toBe(7);
      expect(backfilled.transactionId).toBe(52);
    });

    it('is idempotent: a second run inserts nothing new', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      await world.backfill.run({ confirmedTariffs: confirmed52, write: true });
      const second = await world.backfill.run({
        confirmedTariffs: confirmed52,
        write: true,
      });

      expect(world.records).toHaveLength(1);
      expect(world.inserts).toHaveLength(1);
      expect(second.entries).toHaveLength(0);
    });

    it('never overwrites an existing row on a cdrId race (insert is do-nothing on conflict)', () => {
      expect(INSERT_CDR_RECORD_IF_ABSENT_MUTATION).toMatch(
        /constraint:\s*CdrRecords_cdrId_key/,
      );
      expect(INSERT_CDR_RECORD_IF_ABSENT_MUTATION).toMatch(
        /update_columns:\s*\[\s*\]/,
      );
    });

    it('reports a confirmed tariff that matches no candidate instead of silently ignoring it', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      const report = await world.backfill.run({
        confirmedTariffs: { ...confirmed52, '999': { pricePerKwh: 0.1 } },
        write: true,
      });

      expect(report.unmatchedConfirmations).toEqual(['999']);
    });

    it('rejects a malformed confirmed tariff before doing any work', async () => {
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      await expect(
        world.backfill.run({
          confirmedTariffs: { '52': { pricePerKwh: -1 } as any },
          write: true,
        }),
      ).rejects.toThrow(/pricePerKwh/);
      expect(world.request).not.toHaveBeenCalled();
    });
  });

  describe('report', () => {
    afterEach(() => {
      delete process.env.BILLING_IDLE_RATE_PER_MIN;
    });

    it('prints the full cost breakdown, so a current-rate parking charge is visible to the approver', async () => {
      // 60 minutes parked after the meter stopped, 30 free: 30 min x 0.5/min.
      process.env.BILLING_IDLE_RATE_PER_MIN = JSON.stringify({
        '55102-001': 0.5,
      });
      const world = makeWorld({
        transactions: [
          makeTransaction(52, {
            customData: { unplugTime: '2026-08-27T12:00:00.000Z' },
          }),
        ],
      });

      const report = await world.backfill.run({
        confirmedTariffs: confirmed52,
        write: false,
      });
      const text = formatBackfillReport(report);

      expect(report.entries[0].cdr?.total_parking_cost?.excl_vat).toBe(15);
      expect(text).toMatch(/parking cost: 15 excl VAT/);
      expect(text).toMatch(/current per-station idle rate/);
      expect(text).toMatch(/total_parking_time 1\.0083 h/);
      expect(text).toMatch(/energy cost:\s+1\.35 excl VAT/);
      expect(text).toMatch(/time cost:\s+none/);
      expect(text).toMatch(/fixed cost:\s+none/);
      expect(text).toMatch(/total_cost:\s+16\.35 excl VAT/);
      expect(text).toMatch(/total_energy 13\.5 kWh, total_time 2 h/);
    });

    it('does not label ALREADY_EXISTS or SKIPPED rows with a tariff source', async () => {
      const world = makeWorld({
        transactions: [
          makeTransaction(52),
          makeTransaction(61, { tariffId: null, authorizationId: 9 }),
        ],
        records: [
          { id: 1, cdrId: 'CDR**REX**00052', transactionId: null, cdrData: {} },
        ],
      });

      const report = await world.backfill.run({
        confirmedTariffs: confirmed52,
        write: true,
      });

      const skipped = report.entries.filter((e) => e.status === 'SKIPPED');
      const existing = report.entries.filter(
        (e) => e.status === 'ALREADY_EXISTS',
      );
      expect(existing).toHaveLength(1);
      for (const entry of [...skipped, ...existing]) {
        expect(entry.tariffSource).toBeUndefined();
      }
      expect(formatBackfillReport(report)).not.toMatch(
        /ALREADY_EXISTS\]\n\s+tariff:/,
      );
    });
  });

  describe('partner isolation', () => {
    it('never builds or sends an OCPI request to a partner', async () => {
      const sendSpy = jest.spyOn(CdrsClientApi.prototype, 'request');
      const world = makeWorld({ transactions: [makeTransaction(52)] });

      await world.backfill.run({ confirmedTariffs: confirmed52, write: true });

      expect(sendSpy).not.toHaveBeenCalled();
      sendSpy.mockRestore();

      // Structural guard: the script has no route to a partner at all.
      const source = readFileSync(join(__dirname, 'CdrBackfill.ts'), 'utf8');
      expect(source).not.toMatch(
        /CdrsClientApi|broadcastPostCdr|CdrBroadcaster/,
      );
    });
  });
});
