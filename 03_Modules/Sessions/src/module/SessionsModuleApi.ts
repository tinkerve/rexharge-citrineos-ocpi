// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ISessionsModuleApi } from './ISessionsModuleApi';

import { HttpStatus } from '@citrineos/base';
import {
  AsOcpiFunctionalEndpoint,
  BaseController,
  BodyWithSchema,
  ChargingPreferences,
  ChargingPreferencesResponse,
  ChargingPreferencesResponseSchema,
  ChargingPreferencesResponseSchemaName,
  ChargingPreferencesSchema,
  ChargingPreferencesSchemaName,
  generateMockForSchema,
  generateMockOcpiPaginatedResponse,
  GetTenantPartnerByServerTokenQueryResult,
  ModuleId,
  Paginated,
  PaginatedParams,
  PaginatedSessionResponse,
  PaginatedSessionResponseSchema,
  PaginatedSessionResponseSchemaName,
  ResponseSchema,
  SessionsService,
  versionIdParam,
  Context,
} from '@citrineos/ocpi-base';
import { Ctx, Get, JsonController, Param, Put } from 'routing-controllers';

import { Service } from 'typedi';

const MOCK_PAGINATED_SESSIONS = generateMockOcpiPaginatedResponse(
  PaginatedSessionResponseSchema,
  PaginatedSessionResponseSchemaName,
  new PaginatedParams(),
);
const MOCK_CHARGING_PREFERENCES = generateMockForSchema(
  ChargingPreferencesResponseSchema,
  ChargingPreferencesResponseSchemaName,
);

@JsonController(`/:${versionIdParam}/${ModuleId.Sessions}`)
@Service()
export class SessionsModuleApi
  extends BaseController
  implements ISessionsModuleApi
{
  constructor(readonly sessionsService: SessionsService) {
    super();
  }

  @Get()
  @AsOcpiFunctionalEndpoint()
  @ResponseSchema(
    PaginatedSessionResponseSchema,
    PaginatedSessionResponseSchemaName,
    {
      statusCode: HttpStatus.OK,
      description: 'Successful response',
      examples: {
        success: MOCK_PAGINATED_SESSIONS,
      },
    },
  )
  async getSessions(
    @Ctx()
    { tenantPartner }: Context,
    @Paginated() paginatedParams?: PaginatedParams,
  ): Promise<PaginatedSessionResponse> {
    return this.sessionsService.getSessions(
      tenantPartner.countryCode,
      tenantPartner.partyId,
      tenantPartner.countryCode,
      tenantPartner.partyId,
      paginatedParams?.dateFrom,
      paginatedParams?.dateTo,
      paginatedParams?.offset,
      paginatedParams?.limit,
    );
  }

  @Put('/{sessionId}/charging_preferences')
  @AsOcpiFunctionalEndpoint()
  @ResponseSchema(
    ChargingPreferencesResponseSchema,
    ChargingPreferencesResponseSchemaName,
    {
      statusCode: HttpStatus.OK,
      description: 'Successful response',
      examples: {
        success: MOCK_CHARGING_PREFERENCES,
      },
    },
  )
  async updateChargingPreferences(
    @Param('sessionId') sessionId: string,
    @BodyWithSchema(ChargingPreferencesSchema, ChargingPreferencesSchemaName)
    body: ChargingPreferences,
  ): Promise<ChargingPreferencesResponse> {
    console.log('updateChargingPreferences', sessionId, body);
    return MOCK_CHARGING_PREFERENCES;
  }
}
