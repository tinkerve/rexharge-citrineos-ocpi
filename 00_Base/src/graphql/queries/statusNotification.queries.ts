// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { gql } from 'graphql-request';

export const GET_STATUS_NOTIFICATIONS_IN_RANGE = gql`
  query GetStatusNotificationsInRange(
    $stationId: String!
    $connectorId: Int!
    $tenantId: Int!
    $start: timestamptz!
    $end: timestamptz!
  ) {
    StatusNotifications(
      where: {
        stationId: { _eq: $stationId }
        connectorId: { _eq: $connectorId }
        tenantId: { _eq: $tenantId }
        timestamp: { _gte: $start, _lte: $end }
      }
      order_by: { timestamp: asc }
    ) {
      timestamp
      connectorStatus
    }
  }
`;
