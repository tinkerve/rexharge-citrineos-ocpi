// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { gql } from 'graphql-request';

export const GET_STATUS_NOTIFICATIONS_IN_RANGE = gql`
  query GetStatusNotificationsInRange(
    $stationId: String!
    $evseId: Int!
    $start: timestamptz!
    $end: timestamptz!
  ) {
    StatusNotifications(
      where: {
        stationId: { _eq: $stationId }
        evseId: { _eq: $evseId }
        timestamp: { _gte: $start, _lte: $end }
      }
      order_by: { timestamp: asc }
    ) {
      timestamp
      connectorStatus
    }
  }
`;

export const GET_FIRST_AVAILABLE_STATUS_NOTIFICATION_QUERY = gql`
  query GetFirstAvailableStatusNotification(
    $where: StatusNotifications_bool_exp!
  ) {
    StatusNotifications(where: $where, order_by: { timestamp: asc }, limit: 1) {
      timestamp
    }
  }
`;
