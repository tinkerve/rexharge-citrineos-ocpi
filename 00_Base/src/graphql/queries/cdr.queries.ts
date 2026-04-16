// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { gql } from 'graphql-request';

export const INSERT_CDR_RECORD_MUTATION = gql`
  mutation InsertCdrRecord(
    $cdrId: String!
    $transactionId: Int
    $tenantPartnerId: Int
    $ocpiSessionId: String
    $startDateTime: timestamptz!
    $endDateTime: timestamptz!
    $currency: String!
    $totalEnergy: numeric!
    $totalTime: numeric!
    $totalParkingTime: numeric!
    $totalCostExclVat: numeric!
    $totalCostInclVat: numeric
    $totalEnergyCostExclVat: numeric
    $totalTimeCostExclVat: numeric
    $totalParkingCostExclVat: numeric
    $totalFixedCostExclVat: numeric
    $totalReservationCostExclVat: numeric
    $taxRate: numeric
    $cdrData: jsonb!
    $createdAt: timestamptz!
    $updatedAt: timestamptz!
  ) {
    insert_CdrRecords_one(
      object: {
        cdrId: $cdrId
        transactionId: $transactionId
        tenantPartnerId: $tenantPartnerId
        ocpiSessionId: $ocpiSessionId
        startDateTime: $startDateTime
        endDateTime: $endDateTime
        currency: $currency
        totalEnergy: $totalEnergy
        totalTime: $totalTime
        totalParkingTime: $totalParkingTime
        totalCostExclVat: $totalCostExclVat
        totalCostInclVat: $totalCostInclVat
        totalEnergyCostExclVat: $totalEnergyCostExclVat
        totalTimeCostExclVat: $totalTimeCostExclVat
        totalParkingCostExclVat: $totalParkingCostExclVat
        totalFixedCostExclVat: $totalFixedCostExclVat
        totalReservationCostExclVat: $totalReservationCostExclVat
        taxRate: $taxRate
        cdrData: $cdrData
        createdAt: $createdAt
        updatedAt: $updatedAt
      }
      on_conflict: {
        constraint: CdrRecords_cdrId_key
        update_columns: [updatedAt]
      }
    ) {
      id
      cdrId
    }
  }
`;
