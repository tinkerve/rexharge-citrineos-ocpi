// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { gql } from 'graphql-request';

export const GET_TRANSACTIONS_QUERY = gql`
  query GetTransactions(
    $offset: Int
    $limit: Int
    $where: Transactions_bool_exp!
  ) {
    Transactions(
      offset: $offset
      limit: $limit
      order_by: { createdAt: asc }
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

export const UPDATE_TRANSACTION_CUSTOM_DATA_MUTATION = gql`
  mutation UpdateTransactionCustomData($id: Int!, $customData: jsonb!) {
    update_Transactions_by_pk(
      pk_columns: { id: $id }
      _set: { customData: $customData }
    ) {
      id
      customData
      updatedAt
    }
  }
`;

export const GET_RECENTLY_ENDED_TRANSACTION_BY_EVSE_QUERY = gql`
  query GetRecentlyEndedTransactionByEvse($evseId: Int!, $stationId: String!) {
    Transactions(
      where: {
        evseId: { _eq: $evseId }
        stationId: { _eq: $stationId }
        isActive: { _eq: false }
        endTime: { _is_null: false }
      }
      order_by: { endTime: desc }
      limit: 1
    ) {
      tenant: Tenant {
        countryCode
        partyId
      }
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
      customData
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
      chargingStation: ChargingStation {
        id
        isOnline
        protocol
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

export const GET_TRANSACTION_BY_ID_QUERY = gql`
  query GetTransactionByTransactionId($id: Int!) {
    Transactions(where: { id: { _eq: $id } }) {
      tenant: Tenant {
        countryCode
        partyId
      }
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
      customData
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
      chargingStation: ChargingStation {
        id
        isOnline
        protocol
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

// What an unplug check needs to know about a transaction. The OCPP EVSE id
// comes from the first TransactionEvent that has one (OCPP 2.0.1); OCPP 1.6
// transactions have no TransactionEvents.
const UNPLUG_CANDIDATE_FIELDS = `
  tenant: Tenant {
    countryCode
    partyId
  }
  id
  stationId
  evseId
  locationId
  isActive
  endTime
  stoppedReason
  customData
  transactionEvents: TransactionEvents(
    where: { EvseType: {} }
    order_by: { timestamp: asc }
    limit: 1
  ) {
    EvseType {
      id
    }
  }
  connector: Connector {
    connectorId
    status
    timestamp
  }
`;

// The newest transaction on every EVSE that has one. Unplug catch-up only
// considers that one, so it can never reach past a newer session.
export const GET_UNPLUG_CATCH_UP_CANDIDATES_QUERY = gql`
  query GetUnplugCatchUpCandidates {
    Evses(where: { Transactions: {} }) {
      id
      transactions: Transactions(order_by: { id: desc }, limit: 1) {
        ${UNPLUG_CANDIDATE_FIELDS}
      }
    }
  }
`;

export const GET_UNPLUG_CANDIDATE_BY_TRANSACTION_ID_QUERY = gql`
  query GetUnplugCandidateByTransactionId($id: Int!) {
    Transactions(where: { id: { _eq: $id } }) {
      ${UNPLUG_CANDIDATE_FIELDS}
    }
  }
`;

// Writes customData (carrying unplugTime) only if no unplugTime is stored
// yet. Postgres re-checks the condition under the row lock, so of two
// concurrent writers exactly one gets affected_rows 1.
export const RECORD_TRANSACTION_UNPLUG_TIME_MUTATION = gql`
  mutation RecordTransactionUnplugTime($id: Int!, $customData: jsonb!) {
    update_Transactions(
      where: {
        id: { _eq: $id }
        _or: [
          { customData: { _is_null: true } }
          { _not: { customData: { _has_key: "unplugTime" } } }
        ]
      }
      _set: { customData: $customData }
    ) {
      affected_rows
    }
  }
`;
