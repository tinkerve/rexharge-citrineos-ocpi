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
      if (query.includes('UpdateTransactionCustomData')) {
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
