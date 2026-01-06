// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { OcpiDateTimeSchema } from '../OcpiDateTime';

export const OcpiLocationDTOSchema = z.object({
  evseId: z.number().int(),
  stationId: z.string(),
  physicalReference: z.string().optional(),
  removed: z.boolean().optional(),
  lastUpdated: OcpiDateTimeSchema,
});

export type OcpiLocationDTO = z.infer<typeof OcpiLocationDTOSchema>;
