// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { CredentialsRoleDTOSchema } from './CredentialsRoleDTO';
import { CountryCode } from '../../util/Util';

export const AdminCredentialsRequestDTOSchema = z.object({
  // Our versions URL. Optional: derived from registration.publicBaseUrl when
  // absent, so it is only given for a partner that must reach us elsewhere.
  url: z.string().url().optional(),
  role: CredentialsRoleDTOSchema,
  mspCountryCode: z.nativeEnum(CountryCode),
  mspPartyId: z.string(),
});
export const AdminCredentialsRequestDTOSchemaName =
  'AdminCredentialsRequestDTO';

export type AdminCredentialsRequestDTO = z.infer<
  typeof AdminCredentialsRequestDTOSchema
>;
