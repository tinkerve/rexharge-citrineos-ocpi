// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { IMeterValueDto, ITariffDto, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { LocationsService } from '../services/LocationsService';
import { CdrMapper } from './CdrMapper';
import { SessionMapper } from './SessionMapper';

// A session stopped by Local, Remote or EmergencyStop only learns when the car
// was unplugged from a later connector-Available notification. When that
// notification was never recorded, the CDR still has to end the session
// somewhere: at the transaction's own endTime, then the StopTransaction
// timestamp. Without it end_date_time was empty, total_time 0 and the session
// billed RM 0 (or the CdrRecords insert failed on an empty timestamp).
describe('CdrMapper session end when no unplug was recorded', () => {
  const STATION = '55102-002';
  const START = '2026-08-04T14:00:00.000Z';
  const CHARGING_STOPPED = '2026-08-04T14:10:00.000Z';
  const END_TIME = '2026-08-04T14:10:30.000Z';
  const STOP_TIMESTAMP = '2026-08-04T14:10:31.000Z';

  const TARIFF = {
    id: 3,
    stationId: STATION,
    currency: 'MYR',
    pricePerKwh: 1,
    pricePerMin: 0.6,
    pricePerSession: null,
    taxRate: null,
    tenant: { countryCode: 'MY', partyId: 'REX' },
    updatedAt: '2026-08-01T00:00:00.000Z',
  } as unknown as ITariffDto;

  const meterValue = (timestamp: string, energyWh: number): IMeterValueDto =>
    ({
      timestamp,
      tariffId: 3,
      sampledValue: [
        {
          value: String(energyWh),
          context: 'Sample.Periodic',
          measurand: 'Energy.Active.Import.Register',
          unit: 'Wh',
        },
      ],
    }) as unknown as IMeterValueDto;

  const makeTransaction = (
    overrides: Partial<ITransactionDto> = {},
  ): ITransactionDto =>
    ({
      id: 63,
      transactionId: '11',
      stationId: STATION,
      evseId: 1,
      connectorId: 1,
      isActive: false,
      tenant: { countryCode: 'MY', partyId: 'REX' },
      startTime: START,
      endTime: END_TIME,
      stoppedReason: 'Local',
      totalKwh: 0.43,
      updatedAt: STOP_TIMESTAMP,
      tariffId: 3,
      tariff: TARIFF,
      stopTransaction: { timestamp: STOP_TIMESTAMP, meterStop: 358500 },
      meterValues: [
        meterValue('2026-08-04T14:01:00.000Z', 358070),
        meterValue(CHARGING_STOPPED, 358500),
      ],
      ...overrides,
    }) as unknown as ITransactionDto;

  const makeMapper = (): CdrMapper => {
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    } as unknown as Logger<ILogObj>;
    const sessionMapper = new SessionMapper(
      logger,
      {} as LocationsService,
      {} as OcpiGraphqlClient,
    );
    const mapper = new CdrMapper(
      logger,
      {} as LocationsService,
      {} as OcpiGraphqlClient,
      sessionMapper,
    );
    const location = {
      id: 'LOC1',
      country_code: 'MY',
      party_id: 'REX',
      name: 'Loc',
      address: 'Addr',
      city: 'KL',
      country: 'MYS',
      coordinates: { latitude: '1', longitude: '1' },
    };
    const token = {
      country_code: 'MY',
      party_id: 'REX',
      uid: 'T1',
      type: 'RFID',
      contract_id: 'C1',
    };
    const stubs = {
      getTariffsForTransactions: async (txs: ITransactionDto[]) =>
        new Map(txs.map((t) => [String(t.id), TARIFF])),
      getLocationDTOsForTransactions: async (txs: ITransactionDto[]) =>
        new Map(txs.map((t) => [String(t.id), location])),
      getTokensForTransactions: async (txs: ITransactionDto[]) =>
        new Map(txs.map((t) => [String(t.id), token])),
    };
    Object.assign(mapper, stubs);
    Object.assign(sessionMapper, stubs);
    // Token resolution and CDR location are not what is under test.
    (sessionMapper as unknown as Record<string, unknown>).createCdrToken = () =>
      token;
    (mapper as unknown as Record<string, unknown>).createCdrLocation =
      async () => ({ id: 'LOC1' });
    return mapper;
  };

  const mapCdr = async (transaction: ITransactionDto) => {
    const mapper = makeMapper();
    const [cdr] = await mapper.mapTransactionsToCdrs([transaction], {
      tariffOverrides: new Map([[String(transaction.id), TARIFF]]),
    });
    return cdr;
  };

  afterEach(() => {
    delete process.env.BILLING_IDLE_BUFFER_MINUTES;
    delete process.env.BILLING_IDLE_RATE_PER_MIN;
  });

  it.each(['Local', 'Remote', 'EmergencyStop'])(
    'ends a %s-stopped session at endTime with its real duration',
    async (stoppedReason) => {
      const cdr = await mapCdr(makeTransaction({ stoppedReason }));

      expect(cdr.end_date_time).toBe('2026-08-04T14:10:30.000Z');
      // 10.5 minutes
      expect(cdr.total_time).toBeCloseTo(10.5 / 60, 4);
      expect(cdr.total_time_cost).toBeDefined();
      expect(cdr.total_cost.excl_vat).toBeGreaterThan(0);
    },
  );

  it('falls back to the StopTransaction timestamp when endTime is absent from the row', async () => {
    const cdr = await mapCdr(
      makeTransaction({ endTime: undefined, stoppedReason: 'Local' }),
    );

    expect(cdr.end_date_time).toBe('2026-08-04T14:10:31.000Z');
    expect(cdr.total_time).toBeGreaterThan(0);
  });

  it('bills no post-session parking without an unplug time', async () => {
    process.env.BILLING_IDLE_RATE_PER_MIN = `{"${STATION}":0.5}`;
    process.env.BILLING_IDLE_BUFFER_MINUTES = `{"${STATION}":0}`;
    // Charging stopped at 14:10:00, endTime 14:10:30 -- 30s after, but with
    // no unplug there is no proof the car stayed, so nothing is billed.
    const cdr = await mapCdr(makeTransaction({ stoppedReason: 'Remote' }));

    expect(cdr.total_parking_cost).toBeUndefined();
  });

  it('still bills parking up to the unplug time when one was recorded', async () => {
    process.env.BILLING_IDLE_RATE_PER_MIN = `{"${STATION}":0.5}`;
    process.env.BILLING_IDLE_BUFFER_MINUTES = `{"${STATION}":0}`;
    const cdr = await mapCdr(
      makeTransaction({
        stoppedReason: 'Remote',
        customData: { unplugTime: '2026-08-04T14:40:00.000Z' },
      } as unknown as Partial<ITransactionDto>),
    );

    expect(cdr.end_date_time).toBe('2026-08-04T14:40:00.000Z');
    // 30 minutes after charging stopped at 14:10, at 0.50/min.
    expect(cdr.total_parking_cost?.excl_vat).toBeCloseTo(15, 2);
  });

  it('ends an EVDisconnected session at endTime, parking measured to it', async () => {
    process.env.BILLING_IDLE_RATE_PER_MIN = `{"${STATION}":0.5}`;
    process.env.BILLING_IDLE_BUFFER_MINUTES = `{"${STATION}":0}`;
    const cdr = await mapCdr(
      makeTransaction({
        stoppedReason: 'EVDisconnected',
        endTime: '2026-08-04T14:40:00.000Z',
      }),
    );

    expect(cdr.end_date_time).toBe('2026-08-04T14:40:00.000Z');
    expect(cdr.total_parking_cost?.excl_vat).toBeCloseTo(15, 2);
  });
});
