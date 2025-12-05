// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ICdrsModuleApi } from './ICdrsModuleApi';

import { HttpStatus, ITenantPartnerDto } from '@citrineos/base';
import {
  AsOcpiFunctionalEndpoint,
  BaseController,
  CdrsService,
  generateMockOcpiPaginatedResponse,
  ModuleId,
  Paginated,
  PaginatedCdrResponse,
  PaginatedCdrResponseSchema,
  PaginatedCdrResponseSchemaName,
  PaginatedParams,
  ResponseSchema,
  versionIdParam,
} from '@citrineos/ocpi-base';
import { Ctx, Get, JsonController } from 'routing-controllers';

import { Service } from 'typedi';

const MOCK_PAGINATED_CDRS = generateMockOcpiPaginatedResponse(
  PaginatedCdrResponseSchema,
  PaginatedCdrResponseSchemaName,
  new PaginatedParams(),
);

@JsonController(`/:${versionIdParam}/${ModuleId.Cdrs}`)
@Service()
export class CdrsModuleApi extends BaseController implements ICdrsModuleApi {
  constructor(readonly cdrsService: CdrsService) {
    super();
  }

  @Get()
  @AsOcpiFunctionalEndpoint()
  @ResponseSchema(PaginatedCdrResponseSchema, PaginatedCdrResponseSchemaName, {
    statusCode: HttpStatus.OK,
    description: 'Successful response',
    examples: {
      success: MOCK_PAGINATED_CDRS,
    },
  })
  async getCdrs(
    @Ctx() ctx: any,
    @Paginated() paginationParams?: PaginatedParams,
  ): Promise<PaginatedCdrResponse> {
    const tenantPartner = ctx!.state!.tenantPartner as ITenantPartnerDto;

    return this.cdrsService.getCdrs(
      tenantPartner.tenant!.countryCode!,
      tenantPartner.tenant!.partyId!,
      tenantPartner.countryCode!,
      tenantPartner.partyId!,
      paginationParams?.dateFrom,
      paginationParams?.dateTo,
      paginationParams?.offset,
      paginationParams?.limit,
    );
  }
}
