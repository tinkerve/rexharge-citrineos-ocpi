// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

export interface OcpiRequestLogPayload {
  direction: 'INCOMING' | 'OUTGOING';
  request: {
    method: string;
    url: string;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
  response?: {
    status?: number;
    headers?: Record<string, unknown>;
    body?: unknown;
  };
  ocpiStatusCode?: number;
  error?: {
    name?: string;
    message?: string;
  };
  durationMs?: number;
  partner?: {
    tenantPartnerId?: number;
    countryCode?: string;
    partyId?: string;
  };
  locationId?: string | number;
  requestId?: string;
  correlationId?: string;
  fromCountryCode?: string;
  fromPartyId?: string;
  toCountryCode?: string;
  toPartyId?: string;
  [key: string]: unknown;
}
