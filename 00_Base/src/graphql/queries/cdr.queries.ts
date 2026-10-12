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

export const GET_CDR_RECORDS_QUERY = gql`
  query GetCdrRecords($offset: Int, $limit: Int, $where: CdrRecords_bool_exp!) {
    CdrRecords(
      offset: $offset
      limit: $limit
      order_by: { id: asc }
      where: $where
    ) {
      id
      cdrId
      cdrData
    }
    CdrRecords_aggregate(where: $where) {
      aggregate {
        count
      }
    }
  }
`;

// Backfill: same insert as INSERT_CDR_RECORD_MUTATION, but an existing cdrId is
// left completely untouched. The broadcaster's version bumps updatedAt on
// conflict, which would re-surface an already-delivered CDR in a partner's
// date-window pull.
export const INSERT_CDR_RECORD_IF_ABSENT_MUTATION = gql`
  mutation InsertCdrRecordIfAbsent(
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
      on_conflict: { constraint: CdrRecords_cdrId_key, update_columns: [] }
    ) {
      id
      cdrId
    }
  }
`;

// Completed transactions authorised by a roaming partner: the ones that should
// each have a stored CDR. Same shape the broadcaster hands the mapper at
// session end, so the backfilled CDR is built from the same inputs.
export const GET_CDR_BACKFILL_CANDIDATES_QUERY = gql`
  query GetCdrBackfillCandidates(
    $offset: Int
    $limit: Int
    $where: Transactions_bool_exp!
  ) {
    Transactions(
      offset: $offset
      limit: $limit
      order_by: { id: asc }
      where: $where
    ) {
      id
      stationId
      transactionId
      isActive
      chargingState
      timeSpentCharging
      totalKwh
      stoppedReason
      remoteStartId
      totalCost
      startTime
      endTime
      createdAt
      updatedAt
      evseId
      connectorId
      locationId
      authorizationId
      tariffId
      tenantId
      customData
      tenant: Tenant {
        countryCode
        partyId
      }
      authorization: Authorization {
        tenantPartner: TenantPartner {
          id
          countryCode
          partyId
          partnerProfileOCPI
          tenant: Tenant {
            id
            countryCode
            partyId
          }
        }
        idToken
        additionalInfo
      }
      transactionEvents: TransactionEvents {
        id
        eventType
        EvseType {
          id
        }
        transactionInfo
      }
      startTransaction: StartTransaction {
        timestamp
        meterStart
      }
      stopTransaction: StopTransaction {
        timestamp
        meterStop
      }
      meterValues: MeterValues {
        timestamp
        sampledValue
      }
    }
  }
`;
