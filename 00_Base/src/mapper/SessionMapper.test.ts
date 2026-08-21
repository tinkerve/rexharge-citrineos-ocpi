// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { IMeterValueDto, ITariffDto, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { CdrDimensionType } from '../model/CdrDimensionType';
import { LocationsService } from '../services/LocationsService';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { SessionMapper } from './SessionMapper';

const TARIFF: ITariffDto = {
  id: 3,
  stationId: 'ChargeStationOne',
  currency: 'MYR',
  pricePerKwh: 1,
  pricePerMin: null,
  pricePerSession: null,
  authorizationAmount: null,
  paymentFee: null,
  taxRate: null,
} as ITariffDto;

function makeMeterValue(
  timestamp: string,
  energyWh: number,
  overrides: Partial<IMeterValueDto> = {},
): IMeterValueDto {
  return {
    id: Math.round(energyWh),
    timestamp,
    tariffId: 3,
    transactionDatabaseId: 29,
    sampledValue: [
      {
        value: String(energyWh),
        context: 'Sample.Periodic',
        measurand: 'Energy.Active.Import.Register',
        unit: 'Wh',
      },
    ],
    ...overrides,
  } as unknown as IMeterValueDto;
}

function makeTransaction(
  meterValues: IMeterValueDto[],
  overrides: Partial<ITransactionDto> = {},
): ITransactionDto {
  return {
    id: 29,
    transactionId: '11',
    stationId: 'ChargeStationOne',
    tenant: { countryCode: 'MY', partyId: 'REX' },
    startTime: '2026-08-04T14:03:44.000Z',
    endTime: null,
    totalKwh: 0.66,
    updatedAt: '2026-08-04T14:09:47.800Z',
    tariffId: 3,
    tariff: TARIFF,
    meterValues,
    ...overrides,
  } as unknown as ITransactionDto;
}

function makeMapper(tariff: ITariffDto | null = TARIFF): SessionMapper {
  const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  } as unknown as Logger<ILogObj>;
  const mapper = new SessionMapper(
    logger,
    {} as LocationsService,
    {} as OcpiGraphqlClient,
  );
  // getTariffsForTransactions would otherwise hit GraphQL; the transaction
  // fixture already carries its tariff, so stub the lookup.
  (
    mapper as unknown as {
      getTariffsForTransactions: () => Promise<Map<string, ITariffDto>>;
    }
  ).getTariffsForTransactions = async () =>
    tariff ? new Map([['29', tariff]]) : new Map();
  return mapper;
}

describe('SessionMapper.mapMeterValueToProgressPatch', () => {
  it('sends kwh, total_cost, last_updated and one period with an ENERGY dimension', async () => {
    const previous = makeMeterValue('2026-08-04T14:08:43.000Z', 358070);
    const current = makeMeterValue('2026-08-04T14:09:44.000Z', 358180);
    const transaction = makeTransaction([previous, current]);

    const patch = await makeMapper().mapMeterValueToProgressPatch(
      transaction,
      current,
    );

    expect(patch.kwh).toBe(0.66);
    expect(patch.total_cost).toEqual({ excl_vat: 0.66 });
    // Stamped at the previous reading: this period measures 14:08:43 -> 14:09:44.
    expect(patch.charging_periods).toEqual([
      {
        start_date_time: '2026-08-04T14:08:43.000Z',
        dimensions: [{ type: CdrDimensionType.ENERGY, volume: 0.11 }],
        tariff_id: '3',
      },
    ]);
    expect(patch.last_updated).toBe('2026-08-04T14:09:47.800Z');
  });

  it('sends the full cumulative period history, in order, not just the newest period', async () => {
    const first = makeMeterValue('2026-08-04T14:07:43.000Z', 357000);
    const second = makeMeterValue('2026-08-04T14:08:43.000Z', 358000);
    const third = makeMeterValue('2026-08-04T14:09:44.000Z', 358500);
    // Deliberately unsorted, as a GraphQL result may arrive.
    const transaction = makeTransaction([third, first, second]);

    const patch = await makeMapper().mapMeterValueToProgressPatch(
      transaction,
      third,
    );

    // A receiver that replaces charging_periods wholesale (our own eMSP does)
    // must end up holding the whole history. The dimensionless first period is
    // still dropped.
    expect(patch.charging_periods).toEqual([
      {
        start_date_time: '2026-08-04T14:07:43.000Z',
        dimensions: [{ type: CdrDimensionType.ENERGY, volume: 1 }],
        tariff_id: '3',
      },
      {
        start_date_time: '2026-08-04T14:08:43.000Z',
        dimensions: [{ type: CdrDimensionType.ENERGY, volume: 0.5 }],
        tariff_id: '3',
      },
    ]);
  });

  it('includes the triggering meter value even when the re-hydrated transaction has not caught up', async () => {
    const previous = makeMeterValue('2026-08-04T14:08:43.000Z', 358070);
    const current = makeMeterValue('2026-08-04T14:09:44.000Z', 358180);
    // GraphQL read lag: the row that fired the notification is not in the list.
    const transaction = makeTransaction([previous]);

    const patch = await makeMapper().mapMeterValueToProgressPatch(
      transaction,
      current,
    );

    expect(patch.charging_periods).toEqual([
      {
        start_date_time: '2026-08-04T14:08:43.000Z',
        dimensions: [{ type: CdrDimensionType.ENERGY, volume: 0.11 }],
        tariff_id: '3',
      },
    ]);
  });

  it('does not mutate the transaction meter-value array while sorting', async () => {
    const first = makeMeterValue('2026-08-04T14:09:44.000Z', 358180);
    const second = makeMeterValue('2026-08-04T14:08:43.000Z', 358070);
    const transaction = makeTransaction([first, second]);

    await makeMapper().mapMeterValueToProgressPatch(transaction, first);

    expect(transaction.meterValues?.map((mv) => mv.timestamp)).toEqual([
      '2026-08-04T14:09:44.000Z',
      '2026-08-04T14:08:43.000Z',
    ]);
  });

  it('omits charging_periods for the first meter value, which has no baseline to diff', async () => {
    const first = makeMeterValue('2026-08-04T14:04:44.000Z', 357000);
    const transaction = makeTransaction([first]);

    const patch = await makeMapper().mapMeterValueToProgressPatch(
      transaction,
      first,
    );

    // An empty dimensions array violates ChargingPeriodSchema (min 1), and an
    // empty charging_periods array would clear what the eMSP already holds.
    expect(patch.charging_periods).toBeUndefined();
    expect(patch.kwh).toBe(0.66);
    expect(patch.last_updated).toBe('2026-08-04T14:09:47.800Z');
  });

  it('advances last_updated past a stale transaction row so the eMSP cannot discard the PATCH', async () => {
    const previous = makeMeterValue('2026-08-04T14:08:43.000Z', 358070);
    const current = makeMeterValue('2026-08-04T14:09:44.000Z', 358180);
    // Idle car: totalKwh did not move, so TransactionNotify skipped the update
    // and updatedAt still predates this meter value.
    const transaction = makeTransaction([previous, current], {
      updatedAt: '2026-08-04T14:05:00.000Z',
    } as unknown as Partial<ITransactionDto>);

    const patch = await makeMapper().mapMeterValueToProgressPatch(
      transaction,
      current,
    );

    expect(patch.last_updated).toBe('2026-08-04T14:09:44.000Z');
  });

  it('includes incl_vat and the time and session components when the tariff has them', async () => {
    // Session latches at 14:03:44 but the register does not move until
    // 14:09:44. TIME is billed from that Energy Confirmation, not from the
    // latch, so the warm-up is free.
    const baseline = makeMeterValue('2026-08-04T14:08:43.000Z', 358070);
    const confirmation = makeMeterValue('2026-08-04T14:09:44.000Z', 358180);
    const current = makeMeterValue('2026-08-04T14:12:44.000Z', 358500);
    const transaction = makeTransaction([baseline, confirmation, current]);
    const tariff = {
      ...TARIFF,
      pricePerKwh: 1,
      pricePerMin: 0.1,
      pricePerSession: 0.5,
      taxRate: 0.1,
    } as ITariffDto;

    const patch = await makeMapper(tariff).mapMeterValueToProgressPatch(
      transaction,
      current,
    );

    // TIME is priced on charging duration, so only the two intervals where the
    // register actually advanced count: 61s + 180s = 241s = 0.066944 h.
    // energy 0.66 + time (0.066944 × 6) 0.4017 + session fee 0.5 = 1.5617.
    // Billing the full wall clock from session start would have charged 9
    // minutes of TIME (0.9) instead.
    expect(patch.total_cost?.excl_vat).toBeCloseTo(1.5617, 4);
    expect(patch.total_cost?.incl_vat).toBeCloseTo(1.71787, 4);
  });

  it('bills no time while the charger has latched but not yet delivered energy', async () => {
    // Register never moves: connected, not energised. This is the shape of the
    // five zero-energy sessions already recorded on station 55102-002, which
    // now carries a time-only tariff.
    const first = makeMeterValue('2026-08-04T14:08:43.000Z', 358070);
    const current = makeMeterValue('2026-08-04T14:19:43.000Z', 358070);
    const transaction = makeTransaction([first, current], {
      totalKwh: 0,
    } as unknown as Partial<ITransactionDto>);
    const tariff = {
      ...TARIFF,
      pricePerKwh: 0, // time-only: no energy component to fall to zero on its own
      pricePerMin: 0.6,
      pricePerSession: null,
      taxRate: null,
    } as ITariffDto;

    const patch = await makeMapper(tariff).mapMeterValueToProgressPatch(
      transaction,
      current,
    );

    // 16 minutes connected at RM0.60/min would have billed RM9.60.
    expect(patch.total_cost?.excl_vat).toBe(0);
  });
});

describe('SessionMapper.mapTransactionToCostPatch', () => {
  it('sends only total_cost and last_updated', async () => {
    const transaction = makeTransaction([]);

    const patch = await makeMapper().mapTransactionToCostPatch(transaction);

    expect(patch).toEqual({
      total_cost: { excl_vat: 0.66 },
      last_updated: '2026-08-04T14:09:47.800Z',
    });
  });

  it('returns undefined when no tariff can be resolved', async () => {
    const transaction = makeTransaction([]);

    const patch = await makeMapper(null).mapTransactionToCostPatch(transaction);

    expect(patch).toBeUndefined();
  });
});

describe('SessionMapper.getChargingPeriods', () => {
  it('drops the dimensionless first period and keeps the rest in order', () => {
    const meterValues = [
      makeMeterValue('2026-08-04T14:06:44.000Z', 357000),
      makeMeterValue('2026-08-04T14:07:44.000Z', 358000),
      makeMeterValue('2026-08-04T14:08:44.000Z', 358500),
    ];

    const periods = makeMapper().getChargingPeriods(meterValues, '3');

    expect(periods).toHaveLength(2);
    expect(periods.map((p) => p.start_date_time)).toEqual([
      '2026-08-04T14:06:44.000Z',
      '2026-08-04T14:07:44.000Z',
    ]);
    expect(periods.every((p) => p.dimensions.length > 0)).toBe(true);
  });
});

/**
 * Numbers taken from production session 36 (2026-08-18), the session Gentari
 * reported: meterStart 797700 Wh at 11:54:20, six samples 60s apart, meterStop
 * 798120 Wh at 12:01:19, totalKwh 0.42. Before the register boundaries were
 * bracketed in, the periods summed to 0.31 — 26% short — and Gentari's
 * total_cost check against them failed.
 */
const SESSION_36_SAMPLES = [
  makeMeterValue('2026-08-18T11:55:20.000Z', 797750),
  makeMeterValue('2026-08-18T11:56:20.000Z', 797810),
  makeMeterValue('2026-08-18T11:57:20.000Z', 797880),
  makeMeterValue('2026-08-18T11:58:21.000Z', 797940),
  makeMeterValue('2026-08-18T11:59:21.000Z', 798000),
  makeMeterValue('2026-08-18T12:00:21.000Z', 798060),
];

function makeSession36(
  overrides: Record<string, unknown> = {},
): ITransactionDto {
  return makeTransaction(SESSION_36_SAMPLES, {
    startTime: '2026-08-18T11:54:20.000Z',
    endTime: '2026-08-18T12:05:25.000Z',
    stoppedReason: 'EVDisconnected',
    totalKwh: 0.42,
    updatedAt: '2026-08-18T12:01:19.463Z',
    startTransaction: {
      timestamp: '2026-08-18T11:54:20.000Z',
      meterStart: 797700,
    },
    stopTransaction: {
      timestamp: '2026-08-18T12:01:19.000Z',
      meterStop: 798120,
    },
    ...overrides,
  } as unknown as Partial<ITransactionDto>);
}

describe('SessionMapper.getChargingPeriods register boundaries', () => {
  it('brackets the sampled periods so the volumes sum to the session kwh', () => {
    const periods = makeMapper().getChargingPeriods(
      SESSION_36_SAMPLES,
      '3',
      makeSession36(),
    );

    expect(
      periods.map((period) => [
        period.start_date_time,
        period.dimensions[0].volume,
      ]),
    ).toEqual([
      ['2026-08-18T11:54:20.000Z', 0.05], // meterStart -> first sample
      ['2026-08-18T11:55:20.000Z', 0.06],
      ['2026-08-18T11:56:20.000Z', 0.07],
      ['2026-08-18T11:57:20.000Z', 0.06],
      ['2026-08-18T11:58:21.000Z', 0.06],
      ['2026-08-18T11:59:21.000Z', 0.06],
      ['2026-08-18T12:00:21.000Z', 0.06], // last sample -> meterStop
    ]);

    const summed = periods.reduce(
      (total, period) => total + period.dimensions[0].volume,
      0,
    );
    expect(summed).toBeCloseTo(0.42, 6);
  });

  it('omits the closing boundary while the session is still running', () => {
    const periods = makeMapper().getChargingPeriods(
      SESSION_36_SAMPLES,
      '3',
      makeSession36({ stopTransaction: undefined, endTime: null }),
    );

    // Opening boundary present, closing one cannot exist yet.
    expect(periods).toHaveLength(6);
    expect(periods[0].start_date_time).toBe('2026-08-18T11:54:20.000Z');
    expect(periods[periods.length - 1].start_date_time).toBe(
      '2026-08-18T11:59:21.000Z',
    );
  });

  it('falls back to sampled periods alone when no registers are available', () => {
    // OCPP 2.0.1 has no Start/StopTransaction, so neither register exists.
    const periods = makeMapper().getChargingPeriods(
      SESSION_36_SAMPLES,
      '3',
      makeSession36({
        startTransaction: undefined,
        stopTransaction: undefined,
      }),
    );

    expect(periods).toHaveLength(5);
    expect(periods[0].start_date_time).toBe('2026-08-18T11:55:20.000Z');
  });

  it('skips a boundary that carries no energy', () => {
    // First sample equals meterStart, and the meter did not move after the last.
    const periods = makeMapper().getChargingPeriods(
      SESSION_36_SAMPLES,
      '3',
      makeSession36({
        startTransaction: {
          timestamp: '2026-08-18T11:54:20.000Z',
          meterStart: 797750,
        },
        stopTransaction: {
          timestamp: '2026-08-18T12:01:19.000Z',
          meterStop: 798060,
        },
      }),
    );

    expect(periods).toHaveLength(5);
    expect(periods[0].start_date_time).toBe('2026-08-18T11:55:20.000Z');
  });

  it('reaches the progress PATCH, not just the direct call', async () => {
    const transaction = makeSession36({ stopTransaction: undefined });

    const patch = await makeMapper().mapMeterValueToProgressPatch(
      transaction,
      SESSION_36_SAMPLES[SESSION_36_SAMPLES.length - 1],
    );

    expect(patch.charging_periods?.[0]).toEqual({
      start_date_time: '2026-08-18T11:54:20.000Z',
      dimensions: [{ type: CdrDimensionType.ENERGY, volume: 0.05 }],
      tariff_id: '3',
    });
  });
});

describe('SessionMapper whole-session last_updated', () => {
  it('advances past a stale transaction row so the receiver keeps the closing update', async () => {
    const mapper = makeMapper();
    // The closing restatement runs on the unplug event, whose payload still
    // carries updatedAt 12:01:19 — older than the PATCH sent before it.
    (
      mapper as unknown as {
        getLocationsTokensAndTariffsMapsForTransactions: () => Promise<
          [Map<string, unknown>, Map<string, unknown>, Map<string, unknown>]
        >;
      }
    ).getLocationsTokensAndTariffsMapsForTransactions = async () => [
      new Map(),
      new Map(),
      new Map(),
    ];

    const session =
      await mapper.mapPartialTransactionToPartialSession(makeSession36());

    expect(session.end_date_time).toBe('2026-08-18T12:05:25.000Z');
    expect(session.last_updated).toBe('2026-08-18T12:05:25.000Z');
  });
});

describe('SessionMapper kwh rounding', () => {
  it('keeps float accumulator noise out of kwh and period volumes', async () => {
    const previous = makeMeterValue('2026-08-18T11:55:20.000Z', 797750);
    const current = makeMeterValue('2026-08-18T11:56:20.000Z', 797810);
    const transaction = makeTransaction([previous, current], {
      totalKwh: 0.19000000000005457,
    } as unknown as Partial<ITransactionDto>);

    const patch = await makeMapper().mapMeterValueToProgressPatch(
      transaction,
      current,
    );

    expect(patch.kwh).toBe(0.19);
    expect(patch.charging_periods?.[0].dimensions[0].volume).toBe(0.06);
  });
});
