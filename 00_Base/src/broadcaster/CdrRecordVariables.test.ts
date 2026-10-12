// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITransactionDto } from '@citrineos/base';
import { Cdr } from '../model/Cdr';
import { buildCdrRecordVariables } from './CdrRecordVariables';

describe('buildCdrRecordVariables', () => {
  const cdr = (overrides: Partial<Cdr> = {}): Cdr =>
    ({
      id: 'CDR-1',
      session_id: '63',
      start_date_time: '2026-08-04T14:00:00Z',
      end_date_time: '2026-08-04T14:10:30Z',
      currency: 'MYR',
      total_energy: 0.43,
      total_time: 0.175,
      total_cost: { excl_vat: 1.5 },
      ...overrides,
    }) as unknown as Cdr;
  const transaction = { id: 63 } as unknown as ITransactionDto;

  it('passes the CDR end time through', () => {
    expect(buildCdrRecordVariables(cdr(), transaction).endDateTime).toBe(
      '2026-08-04T14:10:30Z',
    );
  });

  it('refuses a CDR with no end time instead of sending an empty timestamp', () => {
    expect(() =>
      buildCdrRecordVariables(cdr({ end_date_time: '' }), transaction),
    ).toThrow(/no end_date_time/);
  });
});
