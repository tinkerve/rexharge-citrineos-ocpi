// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { IMeterValueDto, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { LocationsService } from '../services/LocationsService';
import { SessionMapper } from './SessionMapper';

// Focus: the energy register as the source of truth for whether a session
// actually charged. Charger status is self-reported and can be wrong in the
// case that matters — EVSE fe50ec85 reported Charging across three sessions
// while transferring 0.000 kWh — so OCPI's "no energy was transferred" test
// has to be answered by the meter, not by StatusNotifications.
describe('BaseTransactionMapper energy readings', () => {
  const makeMeterValue = (
    timestamp: string,
    energyWh: number,
    unit = 'Wh',
  ): IMeterValueDto =>
    ({
      timestamp,
      sampledValue: [
        {
          value: String(energyWh),
          context: 'Sample.Periodic',
          measurand: 'Energy.Active.Import.Register',
          unit,
        },
      ],
    }) as unknown as IMeterValueDto;

  const makeTransaction = (meterValues: IMeterValueDto[]): ITransactionDto =>
    ({
      id: 29,
      startTime: '2026-08-04T14:00:00.000Z',
      meterValues,
    }) as unknown as ITransactionDto;

  const mapper = (): SessionMapper => {
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    } as unknown as Logger<ILogObj>;
    return new SessionMapper(
      logger,
      {} as LocationsService,
      {} as OcpiGraphqlClient,
    );
  };

  // Both members are protected; SessionMapper is a concrete subclass.
  const readings = (transaction: ITransactionDto) =>
    (
      mapper() as unknown as {
        getEnergyReadings: (
          t: ITransactionDto,
        ) => Array<{ timestampMs: number; kwh: number }>;
      }
    ).getEnergyReadings(transaction);

  const confirmed = (transaction: ITransactionDto) =>
    (
      mapper() as unknown as {
        hasEnergyConfirmation: (t: ITransactionDto) => boolean;
      }
    ).hasEnergyConfirmation(transaction);

  afterEach(() => {
    delete process.env.BILLING_ENERGY_THRESHOLD_KWH;
  });

  describe('getEnergyReadings', () => {
    it('sorts readings oldest first regardless of input order', () => {
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:03:00.000Z', 358300),
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358180),
      ]);

      expect(readings(transaction).map((r) => r.kwh)).toEqual([
        358.07, 358.18, 358.3,
      ]);
    });

    it('converts Wh registers to kWh', () => {
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
      ]);

      expect(readings(transaction)[0].kwh).toBeCloseTo(358.07, 6);
    });

    it('accepts registers already reported in kWh', () => {
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358.07, 'kWh'),
      ]);

      expect(readings(transaction)[0].kwh).toBeCloseTo(358.07, 6);
    });

    it('matches the unit case-insensitively', () => {
      // Reading a kWh register as Wh understates the session 1000x, so it never
      // crosses the threshold and the session looks like it never charged.
      // Two production stations report kWh, and one has flipped between kWh and
      // Wh across firmware versions, so casing must not be load-bearing.
      for (const unit of ['kWh', 'KWH', 'kwh']) {
        const transaction = makeTransaction([
          makeMeterValue('2026-08-04T14:01:00.000Z', 358.07, unit),
        ]);

        expect(readings(transaction)[0].kwh).toBeCloseTo(358.07, 6);
      }
    });

    it('confirms energy on a kWh-reporting charger', () => {
      // The end-to-end consequence: a healthy kWh station must reach energy
      // confirmation, or the gateway's no-energy abort stops it mid-charge.
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358.07, 'kWh'),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358.18, 'kWh'),
      ]);

      expect(confirmed(transaction)).toBe(true);
    });

    it('returns nothing when there are no meter values', () => {
      expect(readings(makeTransaction([]))).toEqual([]);
    });
  });

  describe('hasEnergyConfirmation', () => {
    it('is false when the register never moves', () => {
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:03:00.000Z', 358070),
      ]);

      expect(confirmed(transaction)).toBe(false);
    });

    it('is true once the register advances past the threshold', () => {
      // Production shape: real chargers jump ~100 Wh on the sample after the
      // first, roughly 60s in.
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358180),
      ]);

      expect(confirmed(transaction)).toBe(true);
    });

    it('is false for a delta below the threshold', () => {
      // 10 Wh = one register step, under the 20 Wh default.
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358080),
      ]);

      expect(confirmed(transaction)).toBe(false);
    });

    it('is true exactly at the threshold, despite register float error', () => {
      // 358.09 - 358.07 evaluates to 0.019999999999527 in floating point, so an
      // unrounded >= 0.02 would wrongly report false here.
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358090),
      ]);

      expect(confirmed(transaction)).toBe(true);
    });

    it('clears the smallest first step seen in production', () => {
      // Smallest first positive delta across production transactions was 50 Wh,
      // which sits exactly on a 0.05 kWh threshold. 0.02 clears it with margin.
      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358120),
      ]);

      expect(confirmed(transaction)).toBe(true);
    });

    it('is false when there are no meter values', () => {
      expect(confirmed(makeTransaction([]))).toBe(false);
    });

    it('is true for any session when the threshold is disabled', () => {
      process.env.BILLING_ENERGY_THRESHOLD_KWH = '0';

      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358070),
      ]);

      expect(confirmed(transaction)).toBe(true);
    });

    it('honours a custom threshold', () => {
      process.env.BILLING_ENERGY_THRESHOLD_KWH = '0.5';

      const transaction = makeTransaction([
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358180), // +0.11 kWh
      ]);

      expect(confirmed(transaction)).toBe(false);
    });
  });
});

// Whether a register "advanced" decides three things: where charging stopped,
// how much parking is billable, and the live elapsed hours. It was spelled with
// a bare `>` in all three places while only hasEnergyConfirmation reasoned about
// float loss on cumulative registers — so noise below one 10 Wh step counted as
// real charging in one direction and shrank billable idle in the other.
describe('registerAdvanced', () => {
  // registerAdvanced is protected; SessionMapper is a concrete subclass.
  const advanced = (previousKwh: number, nextKwh: number) =>
    (
      new SessionMapper(
        {
          debug: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          info: jest.fn(),
        } as unknown as Logger<ILogObj>,
        {} as LocationsService,
        {} as OcpiGraphqlClient,
      ) as unknown as {
        registerAdvanced: (previous: number, next: number) => boolean;
      }
    ).registerAdvanced(previousKwh, nextKwh);

  it('sees a genuine 10 Wh register step as an advance', () => {
    expect(advanced(358.07, 358.08)).toBe(true);
  });

  it('does not see float noise as an advance', () => {
    // 358.07 + 1e-9: below any register step, so it is noise, not energy.
    expect(advanced(358.07, 358.07 + 1e-9)).toBe(false);
  });

  it('does not see a flat register as an advance', () => {
    expect(advanced(358.07, 358.07)).toBe(false);
  });

  it('does not see a register going backwards as an advance', () => {
    expect(advanced(358.08, 358.07)).toBe(false);
  });
});
