// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { ActiveChargingProfileSchema } from './ActiveChargingProfile';
import { OcpiDateTimeSchema } from './OcpiDateTime';

export const ChargingprofilesActiveSchema = z.object({
  start_date_time: OcpiDateTimeSchema,
  charging_profile: ActiveChargingProfileSchema,
});

export type ChargingprofilesActive = z.infer<
  typeof ChargingprofilesActiveSchema
>;
