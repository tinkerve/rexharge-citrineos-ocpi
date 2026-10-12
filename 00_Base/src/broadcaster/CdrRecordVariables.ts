// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITransactionDto } from '@citrineos/base';
import { InsertCdrRecordMutationVariables } from '../graphql/operations';
import { Cdr } from '../model/Cdr';

/**
 * The single mapping from a CDR to a CdrRecords row. The broadcaster persists
 * through it at session end and the backfill script through it later, so a
 * backfilled row can never differ in shape from a broadcaster-written one —
 * which matters because GET /cdrs serves `cdrData` verbatim.
 */
export function buildCdrRecordVariables(
  cdr: Cdr,
  transaction: ITransactionDto,
  now: string = new Date().toISOString(),
): InsertCdrRecordMutationVariables {
  // CdrRecords.endDateTime is NOT NULL timestamptz: an empty string reaches
  // Postgres as invalid input syntax. Fail here with the transaction named.
  if (!cdr.end_date_time) {
    throw new Error(
      `CDR ${cdr.id} for transaction ${transaction.id} has no end_date_time; refusing to persist an empty endDateTime`,
    );
  }

  const tenantPartnerId =
    transaction.authorization?.tenantPartner?.id ?? undefined;

  return {
    cdrId: cdr.id,
    transactionId: transaction.id ?? undefined,
    tenantPartnerId,
    ocpiSessionId: cdr.session_id ?? undefined,
    startDateTime: cdr.start_date_time,
    endDateTime: cdr.end_date_time,
    currency: cdr.currency,
    totalEnergy: cdr.total_energy,
    totalTime: cdr.total_time,
    totalParkingTime: cdr.total_parking_time ?? 0,
    totalCostExclVat: cdr.total_cost.excl_vat,
    totalCostInclVat: cdr.total_cost.incl_vat ?? undefined,
    totalEnergyCostExclVat: cdr.total_energy_cost?.excl_vat ?? undefined,
    totalTimeCostExclVat: cdr.total_time_cost?.excl_vat ?? undefined,
    totalParkingCostExclVat: cdr.total_parking_cost?.excl_vat ?? undefined,
    totalFixedCostExclVat: cdr.total_fixed_cost?.excl_vat ?? undefined,
    totalReservationCostExclVat:
      cdr.total_reservation_cost?.excl_vat ?? undefined,
    taxRate: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cdrData: cdr as any,
    createdAt: now,
    updatedAt: now,
  };
}
