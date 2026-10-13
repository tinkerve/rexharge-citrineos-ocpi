// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// The ocpi-base barrel drags in OCPP command handlers and @citrineos/data,
// which do not load under jest. The module only needs these pieces; the
// broadcaster, queries and enums are the real sources.
jest.mock('@citrineos/ocpi-base', () => {
  const src = '../../../00_Base/src';
  class Stub {}
  return {
    ...jest.requireActual(`${src}/events/types`),
    ...jest.requireActual(`${src}/graphql/queries/transaction.queries`),
    ...jest.requireActual(`${src}/graphql/queries/cdr.queries`),
    ...jest.requireActual(`${src}/graphql/queries/statusNotification.queries`),
    ...jest.requireActual(`${src}/model/EvseStatus`),
    ...jest.requireActual(`${src}/util/Consts`),
    CdrBroadcaster: jest.requireActual(`${src}/broadcaster/CdrBroadcaster`)
      .CdrBroadcaster,
    AbstractDtoModule: class {},
    AsDtoEventHandler: () => () => undefined,
    OcpiConfigToken: 'OcpiConfigToken',
    CacheWrapper: Stub,
    LocationsBroadcaster: Stub,
    OcpiGraphqlClient: Stub,
    RabbitMqDtoReceiver: Stub,
    SessionBroadcaster: Stub,
  };
});
jest.mock('./module/SessionsModuleApi', () => ({
  SessionsModuleApi: class {},
}));

import 'reflect-metadata';
import { ILogObj, Logger } from 'tslog';
import { CdrBroadcaster, OcpiGraphqlClient } from '@citrineos/ocpi-base';
import { SessionsModule } from './index';

// Focus: a roaming session that ends with EVDisconnected gets exactly one CDR
// pushed to the partner and stored, however CitrineOS splits the stop across
// Transactions updates. OCPP 1.6 StopTransaction writes isActive/endTime
// first, then stoppedReason/totalKwh in a second save; the notify trigger
// sends only the columns each save changed.
describe('SessionsModule CDR broadcast on session end', () => {
  const tenant = { id: 1, countryCode: 'MY', partyId: 'REX' };
  const tenantPartner = {
    id: 3,
    countryCode: 'MY',
    partyId: 'GEN',
    partnerProfileOCPI: {},
  };
  const END = '2026-10-12T10:00:00.000Z';

  type Row = Record<string, any>;

  const setup = (initial: Row) => {
    const row: Row = {
      id: 7,
      stationId: 'CP1',
      evseId: 1,
      locationId: 2,
      transactionId: 'T7',
      tenant,
      authorization: { idToken: 'TOK', tenantPartner },
      customData: {},
      ...initial,
    };
    const cdrRecords: Array<{ cdrId: string; transactionId?: number }> = [];

    const request = jest.fn(async (query: string, variables: any) => {
      if (query.includes('GetTransactionByTransactionId')) {
        return { Transactions: variables.id === row.id ? [{ ...row }] : [] };
      }
      if (query.includes('GetRecentlyEndedTransactionByEvse')) {
        return { Transactions: [{ ...row }] };
      }
      if (query.includes('GetUnplugCandidateByTransactionId')) {
        // The car is still plugged in unless a test says otherwise.
        return {
          Transactions: [
            {
              transactionEvents: [],
              connector: { connectorId: 1, status: 'Occupied', timestamp: END },
              ...row,
            },
          ],
        };
      }
      if (query.includes('RecordTransactionUnplugTime')) {
        if (row.customData?.unplugTime != null) {
          return { update_Transactions: { affected_rows: 0 } };
        }
        row.customData = variables.customData;
        return { update_Transactions: { affected_rows: 1 } };
      }
      if (query.includes('InsertCdrRecord')) {
        if (!cdrRecords.some((r) => r.cdrId === variables.cdrId)) {
          cdrRecords.push({
            cdrId: variables.cdrId,
            transactionId: variables.transactionId,
          });
        }
        return { insert_CdrRecords_one: { id: 1, cdrId: variables.cdrId } };
      }
      if (query.includes('CdrRecords')) {
        return {
          CdrRecords: cdrRecords
            .filter((r) => r.transactionId === variables.transactionId)
            .map((r, i) => ({ id: i + 1, cdrId: r.cdrId })),
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    });
    const client = { request } as unknown as OcpiGraphqlClient;
    const logger = new Logger<ILogObj>({ type: 'hidden' });

    // The partner POST is where a duplicate would hurt; give it a little
    // latency so concurrent handlers genuinely overlap.
    const partnerPost = jest.fn(
      () => new Promise((resolve) => setTimeout(resolve, 5)),
    );
    const cdrMapper = {
      mapTransactionsToCdrs: jest.fn(async (txs: Row[]) =>
        txs.map((tx) => ({
          id: `CDR-${tx.id}`,
          country_code: 'MY',
          party_id: 'REX',
          start_date_time: END,
          end_date_time: END,
          currency: 'MYR',
          total_energy: tx.totalKwh ?? 0,
          total_time: 1,
          total_cost: { excl_vat: 1 },
        })),
      ),
    };
    const cdrBroadcaster = new CdrBroadcaster(
      logger,
      cdrMapper as any,
      { request: partnerPost } as any,
      client,
    );

    const sessionBroadcaster = {
      broadcastPatchSession: jest.fn(async () => undefined),
      broadcastPatchSessionCost: jest.fn(async () => undefined),
    };
    const locationsBroadcaster = {
      broadcastPatchEvseStatus: jest.fn(async () => undefined),
    };

    // The constructor wires a RabbitMQ receiver; the handlers only need the
    // collaborators below.
    const module = Object.create(SessionsModule.prototype) as SessionsModule;
    Object.assign(module, {
      _logger: logger,
      ocpiGraphqlClient: client,
      sessionBroadcaster,
      cdrBroadcaster,
      locationsBroadcaster,
    });

    const transactionUpdate = (payload: Row) =>
      module.handleTransactionUpdate({
        _context: { eventType: 'UPDATE', objectType: 'Transaction' },
        _payload: { id: row.id, tenant, ...payload },
      } as any);

    const connectorAvailable = (timestamp: string) =>
      module.handleConnectorUpdate({
        _context: { eventType: 'UPDATE', objectType: 'Connector' },
        _payload: {
          id: 1,
          evseId: row.evseId,
          stationId: row.stationId,
          status: 'Available',
          timestamp,
        },
      } as any);

    return {
      row,
      cdrRecords,
      partnerPost,
      sessionBroadcaster,
      transactionUpdate,
      connectorAvailable,
    };
  };

  it('sends the CDR when stoppedReason arrives in a second update after isActive/endTime', async () => {
    const s = setup({ isActive: false, endTime: END, stoppedReason: null });

    // Update 1: createStopTransaction — re-fetch still sees no stop reason.
    await s.transactionUpdate({ isActive: false, endTime: END });
    expect(s.partnerPost).not.toHaveBeenCalled();

    // Update 2: module save — only the changed columns.
    s.row.stoppedReason = 'EVDisconnected';
    s.row.totalKwh = 5;
    await s.transactionUpdate({ stoppedReason: 'EVDisconnected', totalKwh: 5 });

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.cdrRecords).toEqual([{ cdrId: 'CDR-7', transactionId: 7 }]);
    // The COMPLETED session PATCH comes from update 2's full row: update 1's
    // row had no stop reason, so it could only report a parked session.
    const patched = s.sessionBroadcaster.broadcastPatchSession.mock.calls.map(
      (c: any[]) => c[1].stoppedReason,
    );
    expect(patched).toEqual([null, 'EVDisconnected']);
  });

  it('sends exactly one CDR when both updates already see EVDisconnected', async () => {
    const s = setup({
      isActive: false,
      endTime: END,
      stoppedReason: 'EVDisconnected',
      totalKwh: 5,
    });

    await s.transactionUpdate({ isActive: false, endTime: END });
    await s.transactionUpdate({ stoppedReason: 'EVDisconnected', totalKwh: 5 });

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.cdrRecords).toHaveLength(1);
  });

  it('sends exactly one CDR when both updates are handled concurrently', async () => {
    const s = setup({
      isActive: false,
      endTime: END,
      stoppedReason: 'EVDisconnected',
      totalKwh: 5,
    });

    await Promise.all([
      s.transactionUpdate({ isActive: false, endTime: END }),
      s.transactionUpdate({ stoppedReason: 'EVDisconnected', totalKwh: 5 }),
    ]);

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.cdrRecords).toHaveLength(1);
  });

  it('still waits for the connector to go Available on a Remote stop', async () => {
    const s = setup({ isActive: false, endTime: END, stoppedReason: null });

    await s.transactionUpdate({ isActive: false, endTime: END });
    s.row.stoppedReason = 'Remote';
    s.row.totalKwh = 5;
    await s.transactionUpdate({ stoppedReason: 'Remote', totalKwh: 5 });

    expect(s.partnerPost).not.toHaveBeenCalled();
    expect(s.cdrRecords).toHaveLength(0);

    await s.connectorAvailable('2026-10-12T10:05:00.000Z');

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.cdrRecords).toHaveLength(1);
    expect(s.row.customData.unplugTime).toBe('2026-10-12T10:05:00.000Z');
  });

  it('leaves in-session updates without a stop reason on the cost path', async () => {
    const s = setup({ isActive: true, endTime: null, stoppedReason: null });

    await s.transactionUpdate({ totalKwh: 3 });

    expect(s.sessionBroadcaster.broadcastPatchSession).not.toHaveBeenCalled();
    expect(s.partnerPost).not.toHaveBeenCalled();
  });
});

// Focus: after the notification listener (re)connects, sessions stopped by a
// command whose unplug was missed while it was deaf get their unplugTime,
// one COMPLETED session PATCH and one CDR, through the live unplug path.
describe('SessionsModule unplug catch-up after (re)connect', () => {
  const tenant = { id: 1, countryCode: 'MY', partyId: 'REX' };
  const tenantPartner = {
    id: 3,
    countryCode: 'MY',
    partyId: 'GEN',
    partnerProfileOCPI: {},
  };
  const END = '2026-10-12T10:00:00.000Z';
  const AT = (min: number) =>
    new Date(Date.parse(END) + min * 60_000).toISOString();

  type Row = Record<string, any>;
  type StatusNotification = {
    stationId: string;
    evseId: number | null;
    connectorId: number;
    connectorStatus: string;
    timestamp: string;
  };

  // An ended Local stop on EVSE `evseId` of station CP<evseId>, connector
  // Available since 5 min after the stop (OCPP 1.6: no TransactionEvents).
  const tx = (id: number, evseId: number, overrides: Row = {}): Row => ({
    id,
    evseId,
    stationId: `CP${evseId}`,
    locationId: 2,
    transactionId: `T${id}`,
    tenant,
    authorization: { idToken: 'TOK', tenantPartner },
    isActive: false,
    endTime: END,
    stoppedReason: 'Local',
    totalKwh: 5,
    customData: {},
    transactionEvents: [],
    connector: { connectorId: 1, status: 'Available', timestamp: AT(5) },
    ...overrides,
  });
  const available = (
    stationId: string,
    timestamp: string,
    extra: Partial<StatusNotification> = {},
  ): StatusNotification => ({
    stationId,
    evseId: null,
    connectorId: 1,
    connectorStatus: 'Available',
    timestamp,
    ...extra,
  });

  // `where` as built by the catch-up: stationId, connectorStatus, timestamp
  // _gte, and either evseId or connectorId.
  const matches = (sn: StatusNotification, where: any): boolean =>
    sn.stationId === where.stationId._eq &&
    sn.connectorStatus === where.connectorStatus._eq &&
    Date.parse(sn.timestamp) >= Date.parse(where.timestamp._gte) &&
    (where.evseId === undefined || sn.evseId === where.evseId._eq) &&
    (where.connectorId === undefined ||
      sn.connectorId === where.connectorId._eq);

  const setup = (
    transactions: Row[],
    statusNotifications: StatusNotification[],
  ) => {
    const cdrRecords: Array<{ cdrId: string; transactionId?: number }> = [];
    const failStatusLookupFor = new Set<string>();
    const unplugWrites: number[] = [];

    const request = jest.fn(async (query: string, variables: any) => {
      if (query.includes('GetUnplugCatchUpCandidates')) {
        const latestByEvse = new Map<number, Row>();
        for (const t of transactions) {
          const seen = latestByEvse.get(t.evseId);
          if (!seen || t.id > seen.id) latestByEvse.set(t.evseId, t);
        }
        return {
          Evses: [...latestByEvse.values()].map((t) => ({
            id: t.evseId,
            transactions: [structuredClone(t)],
          })),
        };
      }
      if (query.includes('GetFirstAvailableStatusNotification')) {
        const { where } = variables;
        if (failStatusLookupFor.has(where.stationId._eq)) {
          throw new Error('Hasura timeout');
        }
        const first = statusNotifications
          .filter((sn) => matches(sn, where))
          .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))[0];
        return { StatusNotifications: first ? [first] : [] };
      }
      if (
        query.includes('GetTransactionByTransactionId') ||
        query.includes('GetUnplugCandidateByTransactionId')
      ) {
        const t = transactions.find((r) => r.id === variables.id);
        return { Transactions: t ? [structuredClone(t)] : [] };
      }
      if (query.includes('GetRecentlyEndedTransactionByEvse')) {
        const ended = transactions
          .filter(
            (t) =>
              t.evseId === variables.evseId &&
              t.stationId === variables.stationId &&
              t.isActive === false &&
              t.endTime != null,
          )
          .sort((a, b) => Date.parse(b.endTime) - Date.parse(a.endTime));
        return {
          Transactions: ended.slice(0, 1).map((t) => structuredClone(t)),
        };
      }
      if (query.includes('RecordTransactionUnplugTime')) {
        // Conditional on no unplugTime yet, as in Postgres under the row lock.
        const t = transactions.find((r) => r.id === variables.id)!;
        if (t.customData?.unplugTime != null) {
          return { update_Transactions: { affected_rows: 0 } };
        }
        t.customData = variables.customData;
        unplugWrites.push(variables.id);
        return { update_Transactions: { affected_rows: 1 } };
      }
      if (query.includes('InsertCdrRecord')) {
        if (!cdrRecords.some((r) => r.cdrId === variables.cdrId)) {
          cdrRecords.push({
            cdrId: variables.cdrId,
            transactionId: variables.transactionId,
          });
        }
        return { insert_CdrRecords_one: { id: 1, cdrId: variables.cdrId } };
      }
      if (query.includes('CdrRecords')) {
        return {
          CdrRecords: cdrRecords
            .filter((r) => r.transactionId === variables.transactionId)
            .map((r, i) => ({ id: i + 1, cdrId: r.cdrId })),
        };
      }
      throw new Error(`Unexpected query: ${query}`);
    });
    const client = { request } as unknown as OcpiGraphqlClient;
    const logger = new Logger<ILogObj>({ type: 'hidden' });

    const partnerPost = jest.fn(
      () => new Promise((resolve) => setTimeout(resolve, 5)),
    );
    const cdrMapper = {
      mapTransactionsToCdrs: jest.fn(async (txs: Row[]) =>
        txs.map((t) => ({
          id: `CDR-${t.id}`,
          country_code: 'MY',
          party_id: 'REX',
          start_date_time: END,
          end_date_time: END,
          currency: 'MYR',
          total_energy: t.totalKwh ?? 0,
          total_time: 1,
          total_cost: { excl_vat: 1 },
        })),
      ),
    };
    const cdrBroadcaster = new CdrBroadcaster(
      logger,
      cdrMapper as any,
      { request: partnerPost } as any,
      client,
    );
    const sessionBroadcaster = {
      // Snapshot: the module may mutate the DTO after broadcasting it.
      broadcastPatchSession: jest.fn(
        async (_tenant: any, _tx: Row) => undefined,
      ),
    };
    const locationsBroadcaster = {
      broadcastPatchEvseStatus: jest.fn(async () => undefined),
    };

    const module = Object.create(SessionsModule.prototype) as SessionsModule;
    Object.assign(module, {
      _logger: logger,
      ocpiGraphqlClient: client,
      sessionBroadcaster,
      cdrBroadcaster,
      locationsBroadcaster,
    });

    const unplugTimeOf = (id: number) =>
      transactions.find((r) => r.id === id)!.customData?.unplugTime;
    const cdrIds = () => cdrRecords.map((r) => r.cdrId).sort();
    const patchedIds = () =>
      sessionBroadcaster.broadcastPatchSession.mock.calls
        .map((c: any[]) => c[1].id)
        .sort();
    // Session PATCHes that report the recorded unplug (COMPLETED).
    const unplugPatchedIds = () =>
      sessionBroadcaster.broadcastPatchSession.mock.calls
        .filter((c: any[]) => c[1].customData?.unplugTime != null)
        .map((c: any[]) => c[1].id)
        .sort();

    // Notification payloads carry only the changed columns.
    const transactionUpdate = (id: number, payload: Row) =>
      module.handleTransactionUpdate({
        _context: { eventType: 'UPDATE', objectType: 'Transaction' },
        _payload: { id, tenant, ...payload },
      } as any);
    const connectorAvailable = (t: Row, timestamp: string) =>
      module.handleConnectorUpdate({
        _context: { eventType: 'UPDATE', objectType: 'Connector' },
        _payload: {
          id: 1,
          evseId: t.evseId,
          stationId: t.stationId,
          status: 'Available',
          timestamp,
        },
      } as any);

    return {
      module,
      unplugWrites,
      unplugPatchedIds,
      transactionUpdate,
      connectorAvailable,
      request,
      partnerPost,
      sessionBroadcaster,
      locationsBroadcaster,
      failStatusLookupFor,
      unplugTimeOf,
      cdrIds,
      patchedIds,
    };
  };

  it('records the unplug of an ended Local stop and sends one session PATCH and one CDR', async () => {
    const s = setup([tx(7, 1)], [available('CP1', AT(5))]);

    await s.module.catchUpMissedUnplugs();

    expect(s.unplugTimeOf(7)).toBe(AT(5));
    expect(s.patchedIds()).toEqual([7]);
    expect(s.cdrIds()).toEqual(['CDR-7']);
    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(
      s.locationsBroadcaster.broadcastPatchEvseStatus,
    ).toHaveBeenCalledTimes(1);
  });

  it('handles a Remote stop the same way', async () => {
    const s = setup(
      [tx(7, 1, { stoppedReason: 'Remote' })],
      [available('CP1', AT(5))],
    );

    await s.module.catchUpMissedUnplugs();

    expect(s.unplugTimeOf(7)).toBe(AT(5));
    expect(s.cdrIds()).toEqual(['CDR-7']);
  });

  it("takes the unplug time from the first Available status after the stop, not the connector's latest one", async () => {
    // Unplugged at +3 min, then Faulted, then Available again at +30 min.
    const s = setup(
      [
        tx(7, 1, {
          connector: { connectorId: 1, status: 'Available', timestamp: AT(30) },
        }),
      ],
      [
        available('CP1', AT(-60)),
        available('CP1', AT(3)),
        { ...available('CP1', AT(10)), connectorStatus: 'Faulted' },
        available('CP1', AT(30)),
      ],
    );

    await s.module.catchUpMissedUnplugs();

    expect(s.unplugTimeOf(7)).toBe(AT(3));
  });

  it('matches OCPP 2.0.1 status notifications by EVSE and 1.6 ones by connector', async () => {
    const s = setup(
      [
        // 2.0.1: OCPP evseId 2 from the TransactionEvents.
        tx(7, 1, { transactionEvents: [{ EvseType: { id: 2 } }] }),
        // 1.6: station-wide connectorId 2.
        tx(8, 3, {
          connector: { connectorId: 2, status: 'Available', timestamp: AT(9) },
        }),
      ],
      [
        available('CP1', AT(4), { evseId: 1, connectorId: 1 }),
        available('CP1', AT(6), { evseId: 2, connectorId: 1 }),
        available('CP3', AT(2), { connectorId: 1 }),
        available('CP3', AT(9), { connectorId: 2 }),
      ],
    );

    await s.module.catchUpMissedUnplugs();

    expect(s.unplugTimeOf(7)).toBe(AT(6));
    expect(s.unplugTimeOf(8)).toBe(AT(9));
  });

  it('skips sessions it must not touch', async () => {
    const s = setup(
      [
        // EVSE 1: stopped by the EV unplugging; its CDR already went out.
        tx(1, 1, { stoppedReason: 'EVDisconnected' }),
        // EVSE 2: unplug already recorded.
        tx(2, 2, { customData: { unplugTime: AT(1) } }),
        // EVSE 3: car still plugged in.
        tx(3, 3, {
          connector: { connectorId: 1, status: 'Occupied', timestamp: AT(5) },
        }),
        // EVSE 4: connector went Available before the session ended.
        tx(4, 4, {
          connector: { connectorId: 1, status: 'Available', timestamp: AT(-1) },
        }),
        // EVSE 5: a newer session is running.
        tx(5, 5),
        tx(15, 5, { isActive: true, endTime: null, stoppedReason: null }),
        // EVSE 6: a newer session has already ended (EV unplugged).
        tx(6, 6),
        tx(16, 6, { stoppedReason: 'EVDisconnected' }),
        // EVSE 7: connector Available but no Available status notification
        // at or after the stop.
        tx(7, 7),
      ],
      [1, 2, 3, 4, 5, 6]
        .map((evse) => available(`CP${evse}`, AT(5)))
        .concat(available('CP7', AT(-1))),
    );

    await s.module.catchUpMissedUnplugs();

    for (const id of [1, 3, 4, 5, 6, 7, 15, 16]) {
      expect(s.unplugTimeOf(id)).toBeUndefined();
    }
    expect(s.unplugTimeOf(2)).toBe(AT(1));
    expect(s.patchedIds()).toEqual([]);
    expect(s.partnerPost).not.toHaveBeenCalled();
  });

  it('sends no duplicate CDR or session PATCH when run twice', async () => {
    const s = setup([tx(7, 1)], [available('CP1', AT(5))]);

    await s.module.catchUpMissedUnplugs();
    await s.module.catchUpMissedUnplugs();

    expect(s.cdrIds()).toEqual(['CDR-7']);
    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.patchedIds()).toEqual([7]);
  });

  it('sends no duplicate when runs overlap (a reconnect during catch-up)', async () => {
    const s = setup([tx(7, 1)], [available('CP1', AT(5))]);

    await Promise.all([
      s.module.catchUpMissedUnplugs(),
      s.module.catchUpMissedUnplugs(),
    ]);

    expect(s.partnerPost).toHaveBeenCalledTimes(1);
    expect(s.patchedIds()).toEqual([7]);
  });

  it('keeps going when one session fails, and never throws', async () => {
    const s = setup(
      [tx(7, 1), tx(8, 2)],
      [available('CP1', AT(5)), available('CP2', AT(5))],
    );
    s.failStatusLookupFor.add('CP1');

    await expect(s.module.catchUpMissedUnplugs()).resolves.toBeUndefined();

    expect(s.unplugTimeOf(7)).toBeUndefined();
    expect(s.unplugTimeOf(8)).toBe(AT(5));
    expect(s.cdrIds()).toEqual(['CDR-8']);
  });

  it('never throws when the candidate lookup itself fails', async () => {
    const s = setup([tx(7, 1)], [available('CP1', AT(5))]);
    s.request.mockRejectedValueOnce(new Error('Hasura down'));

    await expect(s.module.catchUpMissedUnplugs()).resolves.toBeUndefined();
    expect(s.partnerPost).not.toHaveBeenCalled();
  });

  it('matches a 2.0.1 session by the first TransactionEvent that names an EVSE', async () => {
    // Hasura returns only events with an EvseType; even if an event without
    // one slipped through, it must not fall back to the connector id.
    const s = setup(
      [
        tx(7, 1, {
          transactionEvents: [{ EvseType: null }, { EvseType: { id: 2 } }],
        }),
      ],
      [
        available('CP1', AT(4), { evseId: 1, connectorId: 1 }),
        available('CP1', AT(6), { evseId: 2, connectorId: 1 }),
      ],
    );

    await s.module.catchUpMissedUnplugs();

    expect(s.unplugTimeOf(7)).toBe(AT(6));
    const query = s.request.mock.calls.find(([q]) =>
      q.includes('GetUnplugCatchUpCandidates'),
    )![0] as string;
    expect(query.replace(/\s+/g, ' ')).toContain(
      'TransactionEvents( where: { EvseType: {} } order_by: { timestamp: asc } limit: 1 )',
    );
  });

  describe('when the connector goes Available before the session-end update lands', () => {
    // 51000-* stations: the Available StatusNotification is processed before
    // Citrine writes the stop (isActive/endTime, then stoppedReason) ~60 s
    // later, so the live connector handler finds no ended session.
    const plugged = (id: number, overrides: Row = {}) =>
      tx(id, 1, {
        isActive: true,
        endTime: null,
        stoppedReason: null,
        connector: { connectorId: 1, status: 'Occupied', timestamp: AT(-30) },
        ...overrides,
      });

    it('records the unplug once the stop is fully written: one write, one COMPLETED PATCH, one CDR', async () => {
      const t = plugged(472);
      const s = setup([t], [available('CP1', AT(1))]);

      // Unplug at +1 min: the live handler runs while the session is active.
      t.connector = { connectorId: 1, status: 'Available', timestamp: AT(1) };
      await s.connectorAvailable(t, AT(1));
      expect(s.unplugTimeOf(472)).toBeUndefined();

      // The stop lands in two partial updates.
      Object.assign(t, { isActive: false, endTime: END });
      await s.transactionUpdate(472, { isActive: false, endTime: END });
      expect(s.unplugTimeOf(472)).toBeUndefined();

      t.stoppedReason = 'Remote';
      await s.transactionUpdate(472, { stoppedReason: 'Remote' });

      expect(s.unplugTimeOf(472)).toBe(AT(1));
      expect(s.unplugWrites).toEqual([472]);
      expect(s.unplugPatchedIds()).toEqual([472]);
      expect(s.cdrIds()).toEqual(['CDR-472']);
      expect(s.partnerPost).toHaveBeenCalledTimes(1);
    });

    it('records it once when both stop updates already see the stop reason', async () => {
      const t = plugged(472, {
        isActive: false,
        endTime: END,
        stoppedReason: 'Remote',
        connector: { connectorId: 1, status: 'Available', timestamp: AT(1) },
      });
      const s = setup([t], [available('CP1', AT(1))]);

      await Promise.all([
        s.transactionUpdate(472, { isActive: false, endTime: END }),
        s.transactionUpdate(472, { stoppedReason: 'Remote' }),
      ]);

      expect(s.unplugWrites).toEqual([472]);
      expect(s.unplugPatchedIds()).toEqual([472]);
      expect(s.partnerPost).toHaveBeenCalledTimes(1);
    });

    it('leaves an EVDisconnected stop to its own CDR path', async () => {
      const t = plugged(472, {
        connector: { connectorId: 1, status: 'Available', timestamp: AT(1) },
      });
      const s = setup([t], [available('CP1', AT(1))]);

      Object.assign(t, {
        isActive: false,
        endTime: END,
        stoppedReason: 'EVDisconnected',
      });
      await s.transactionUpdate(472, { isActive: false, endTime: END });
      await s.transactionUpdate(472, { stoppedReason: 'EVDisconnected' });

      expect(s.unplugTimeOf(472)).toBeUndefined();
      expect(s.unplugWrites).toEqual([]);
      expect(s.cdrIds()).toEqual(['CDR-472']);
      expect(s.partnerPost).toHaveBeenCalledTimes(1);
    });
  });

  it('still records an unplug after the stop through the live connector path, exactly once', async () => {
    const t = tx(472, 1, {
      isActive: true,
      endTime: null,
      stoppedReason: null,
      connector: { connectorId: 1, status: 'Occupied', timestamp: AT(-30) },
    });
    const s = setup([t], []);

    Object.assign(t, { isActive: false, endTime: END });
    await s.transactionUpdate(472, { isActive: false, endTime: END });
    t.stoppedReason = 'Remote';
    t.connector = { connectorId: 1, status: 'Finishing', timestamp: END };
    await s.transactionUpdate(472, { stoppedReason: 'Remote' });
    expect(s.unplugWrites).toEqual([]);

    t.connector = { connectorId: 1, status: 'Available', timestamp: AT(5) };
    await s.connectorAvailable(t, AT(5));

    expect(s.unplugTimeOf(472)).toBe(AT(5));
    expect(s.unplugWrites).toEqual([472]);
    expect(s.unplugPatchedIds()).toEqual([472]);
    expect(s.partnerPost).toHaveBeenCalledTimes(1);
  });

  it('lets only one of overlapping recorders write and broadcast', async () => {
    const t = tx(7, 1, { stoppedReason: 'Remote' });
    const s = setup([t], [available('CP1', AT(5))]);

    await Promise.all([
      s.connectorAvailable(t, AT(5)),
      s.module.catchUpMissedUnplugs(),
      s.transactionUpdate(7, { stoppedReason: 'Remote' }),
    ]);

    expect(s.unplugWrites).toEqual([7]);
    expect(s.unplugPatchedIds()).toEqual([7]);
    expect(
      s.locationsBroadcaster.broadcastPatchEvseStatus,
    ).toHaveBeenCalledTimes(1);
    expect(s.partnerPost).toHaveBeenCalledTimes(1);
  });
});
