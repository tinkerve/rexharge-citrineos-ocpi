// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { Service } from 'typedi';
import { DEFAULT_LIMIT, DEFAULT_OFFSET } from '../model/PaginatedResponse';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { GET_CDR_RECORDS_QUERY } from '../graphql/queries/cdr.queries';
import {
  CdrRecords_Bool_Exp,
  GetCdrRecordsQueryResult,
  GetCdrRecordsQueryVariables,
} from '../graphql/operations';

@Service()
export class CdrsService {
  constructor(private readonly ocpiGraphqlClient: OcpiGraphqlClient) {}

  /**
   * Serves the CDRs persisted at session end (CdrRecords.cdrData) exactly as
   * stored. They are never rebuilt from transactions, so a later tariff edit
   * or mapper change cannot alter a CDR a partner has already received.
   */
  public async getCdrs(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    dateFrom?: Date,
    dateTo?: Date,
    offset: number = DEFAULT_OFFSET,
    limit: number = DEFAULT_LIMIT,
  ) {
    const where: CdrRecords_Bool_Exp = {
      TenantPartner: {
        countryCode: { _eq: fromCountryCode },
        partyId: { _eq: fromPartyId },
      },
      Transaction: {
        Tenant: {
          countryCode: { _eq: toCountryCode },
          partyId: { _eq: toPartyId },
        },
      },
    };
    const dateFilters: any = {};
    if (dateFrom) dateFilters._gte = dateFrom.toISOString();
    if (dateTo) dateFilters._lte = dateTo.toISOString();
    if (Object.keys(dateFilters).length > 0) {
      where.updatedAt = dateFilters;
    }
    const result = await this.ocpiGraphqlClient.request<
      GetCdrRecordsQueryResult,
      GetCdrRecordsQueryVariables
    >(GET_CDR_RECORDS_QUERY, { offset, limit, where });

    return {
      data: result.CdrRecords.map((record) => record.cdrData),
      total: result.CdrRecords_aggregate.aggregate?.count ?? 0,
      offset: offset,
      limit: limit,
    };
  }
}
