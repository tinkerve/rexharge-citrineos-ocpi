// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

/**
 * ISO 8601 DateTime schema for OCPI compliance.
 *
 * According to OCPI 2.2.1 specification, all timestamps must be formatted as
 * strings following RFC 3339 with the following constraints:
 * - All timestamps SHALL be in UTC
 * - The absence of the timezone designator implies a UTC timestamp
 * - Fractional seconds MAY be used
 *
 * Valid examples:
 * - 2015-06-29T20:39:09Z
 * - 2015-06-29T20:39:09
 * - 2016-12-29T17:45:09.2Z
 * - 2018-01-01T01:08:01.123Z
 */
export const OcpiDateTimeSchema = z
  .union([z.string(), z.date()])
  .transform((value) => {
    if (typeof value === 'string') {
      return value;
    }
    // Convert Date objects to ISO string for API serialization
    return value.toISOString();
  });

export type OcpiDateTime = string;
