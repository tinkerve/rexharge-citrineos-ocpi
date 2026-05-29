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
      }
      stopTransaction: StopTransaction {
        timestamp
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
      }
      stopTransaction: StopTransaction {
        timestamp
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
      }
      stopTransaction: StopTransaction {
        timestamp
      }
      meterValues: MeterValues {
        timestamp
        sampledValue
      }
    }
  }
`;
