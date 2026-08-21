// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { IMeterValueDto, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { Session } from '../model/Session';
import { LocationsService } from '../services/LocationsService';
import { CdrMapper } from './CdrMapper';
import { SessionMapper } from './SessionMapper';

// Focus: idle is charged for hogging a connector AFTER charging finished, and
// for nothing else. The warm-up before the first energy and any mid-session
// stall are the charger's fault and must stay free — they land in
// total_parking_time for reporting, but must never reach total_parking_cost.
describe('CdrMapper billable post-charging idle', () => {
  const STATION = '55102-002';

  const makeMeterValue = (
    timestamp: string,
    energyWh: number,
  ): IMeterValueDto =>
    ({
      timestamp,
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
    meterValues: IMeterValueDto[],
    overrides: Partial<ITransactionDto> = {},
  ): ITransactionDto =>
    ({
      id: 29,
      stationId: STATION,
      startTime: '2026-08-04T14:00:00.000Z',
      meterValues,
      ...overrides,
    }) as unknown as ITransactionDto;

  const session = {
    start_date_time: '2026-08-04T14:00:00.000Z',
    end_date_time: '2026-08-04T15:00:00.000Z',
  } as unknown as Session;

  const billableIdle = (
    transaction: ITransactionDto,
    sessionOverride: Session = session,
  ): number => {
    const logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
    } as unknown as Logger<ILogObj>;
    const mapper = new CdrMapper(
      logger,
      {} as LocationsService,
      {} as OcpiGraphqlClient,
      new SessionMapper(
        logger,
        {} as LocationsService,
        {} as OcpiGraphqlClient,
      ),
    );
    return (
      mapper as unknown as {
        calculateBillablePostChargingIdle: (
          s: Session,
          t: ITransactionDto,
        ) => number;
      }
    ).calculateBillablePostChargingIdle(sessionOverride, transaction);
  };

  afterEach(() => {
    delete process.env.BILLING_IDLE_BUFFER_MINUTES;
  });

  it('charges nothing while the session is inside the free buffer', () => {
    // Charging stops at 14:10, unplugged at 14:30 — 20 minutes idle, under the
    // 30 minute default buffer.
    const transaction = makeTransaction(
      [
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:10:00.000Z', 358500),
      ],
      {
        customData: { unplugTime: '2026-08-04T14:30:00.000Z' },
      } as unknown as Partial<ITransactionDto>,
    );

    expect(billableIdle(transaction)).toBe(0);
  });

  it('charges only the idle time beyond the buffer', () => {
    // Charging stops at 14:10, unplugged at 15:10 — 60 minutes idle, so 30
    // billable after the 30 minute buffer.
    const transaction = makeTransaction(
      [
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:10:00.000Z', 358500),
      ],
      {
        customData: { unplugTime: '2026-08-04T15:10:00.000Z' },
      } as unknown as Partial<ITransactionDto>,
    );

    expect(billableIdle(transaction)).toBeCloseTo(0.5, 4); // 30 min in hours
  });

  it('never charges idle for a session that delivered no energy', () => {
    // A car left on a dead charger for two hours is not hogging — the charger
    // never gave it anything to finish.
    const transaction = makeTransaction(
      [
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:02:00.000Z', 358070),
      ],
      {
        customData: { unplugTime: '2026-08-04T16:00:00.000Z' },
      } as unknown as Partial<ITransactionDto>,
    );

    expect(billableIdle(transaction)).toBe(0);
  });

  it('measures from the last advancing reading, not the last reading', () => {
    // Register stalls at 14:10 but the charger keeps reporting until 14:40.
    // Idle runs from 14:10, so unplugging at 15:10 gives 60 min, 30 billable.
    const transaction = makeTransaction(
      [
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:10:00.000Z', 358500),
        makeMeterValue('2026-08-04T14:25:00.000Z', 358500),
        makeMeterValue('2026-08-04T14:40:00.000Z', 358500),
      ],
      {
        customData: { unplugTime: '2026-08-04T15:10:00.000Z' },
      } as unknown as Partial<ITransactionDto>,
    );

    expect(billableIdle(transaction)).toBeCloseTo(0.5, 4);
  });

  it('does not count the warm-up before the first energy as idle', () => {
    // 9 minutes of warm-up before the register moves. Unplugged 30 minutes
    // after charging stops, exactly the buffer, so nothing is billable — the
    // warm-up must not push it over.
    const transaction = makeTransaction(
      [
        makeMeterValue('2026-08-04T14:09:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:10:00.000Z', 358500),
      ],
      {
        customData: { unplugTime: '2026-08-04T14:40:00.000Z' },
      } as unknown as Partial<ITransactionDto>,
    );

    expect(billableIdle(transaction)).toBe(0);
  });

  it('honours a per-station buffer override', () => {
    process.env.BILLING_IDLE_BUFFER_MINUTES = `{"${STATION}":10}`;

    const transaction = makeTransaction(
      [
        makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
        makeMeterValue('2026-08-04T14:10:00.000Z', 358500),
      ],
      {
        customData: { unplugTime: '2026-08-04T14:40:00.000Z' },
      } as unknown as Partial<ITransactionDto>,
    );

    // 30 min idle, 10 min buffer, 20 billable.
    expect(billableIdle(transaction)).toBeCloseTo(1 / 3, 4);
  });

  it('falls back to session end when no unplug time was recorded', () => {
    const transaction = makeTransaction([
      makeMeterValue('2026-08-04T14:01:00.000Z', 358070),
      makeMeterValue('2026-08-04T14:10:00.000Z', 358500),
    ]);

    // Session ends 15:00, charging stopped 14:10 — 50 min idle, 20 billable.
    expect(billableIdle(transaction)).toBeCloseTo(1 / 3, 4);
  });
});
