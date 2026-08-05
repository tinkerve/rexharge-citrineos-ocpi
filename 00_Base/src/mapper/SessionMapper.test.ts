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
    expect(patch.charging_periods).toEqual([
      {
        start_date_time: '2026-08-04T14:09:44.000Z',
        dimensions: [
          { type: CdrDimensionType.ENERGY, volume: 0.11 },
        ],
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
        start_date_time: '2026-08-04T14:08:43.000Z',
        dimensions: [{ type: CdrDimensionType.ENERGY, volume: 1 }],
        tariff_id: '3',
      },
      {
        start_date_time: '2026-08-04T14:09:44.000Z',
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
        start_date_time: '2026-08-04T14:09:44.000Z',
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
    const previous = makeMeterValue('2026-08-04T14:08:43.000Z', 358070);
    const current = makeMeterValue('2026-08-04T14:09:44.000Z', 358180);
    const transaction = makeTransaction([previous, current]);
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

    // energy 0.66 + time (6 min elapsed × 0.1) 0.6 + session fee 0.5 = 1.76
    expect(patch.total_cost?.excl_vat).toBeCloseTo(1.76, 4);
    expect(patch.total_cost?.incl_vat).toBeCloseTo(1.936, 4);
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

    const patch =
      await makeMapper(null).mapTransactionToCostPatch(transaction);

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
      '2026-08-04T14:07:44.000Z',
      '2026-08-04T14:08:44.000Z',
    ]);
    expect(periods.every((p) => p.dimensions.length > 0)).toBe(true);
  });
});
