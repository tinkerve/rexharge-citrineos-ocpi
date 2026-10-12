// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { HttpMethod, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { Service } from 'typedi';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import {
  InsertCdrRecordMutationResult,
  InsertCdrRecordMutationVariables,
} from '../graphql/operations';
import { INSERT_CDR_RECORD_MUTATION } from '../graphql/queries/cdr.queries';
import { CdrMapper } from '../mapper/CdrMapper';
import { Cdr } from '../model/Cdr';
import { OcpiEmptyResponseSchema } from '../model/OcpiEmptyResponse';
import { CdrsClientApi } from '../trigger/CdrsClientApi';
import { BaseBroadcaster } from './BaseBroadcaster';
import { buildCdrRecordVariables } from './CdrRecordVariables';

@Service()
export class CdrBroadcaster extends BaseBroadcaster {
  constructor(
    readonly logger: Logger<ILogObj>,
    readonly cdrMapper: CdrMapper,
    readonly cdrsClientApi: CdrsClientApi,
    readonly ocpiGraphqlClient: OcpiGraphqlClient,
  ) {
    super();
  }

  async broadcastPostCdr(transactionDto: ITransactionDto): Promise<void> {
    const cdrs: Cdr[] = await this.cdrMapper.mapTransactionsToCdrs([
      transactionDto,
    ]);
    if (cdrs.length === 0) {
      this.logger.warn(
        `No CDRs generated for Transaction: ${transactionDto.id}`,
      );
      return;
    }
    const cdrDto = cdrs[0];
    const tenantPartner =
      transactionDto.authorization?.tenantPartner ?? undefined;

    try {
      if (tenantPartner) {
        // CDR is the bill for this session — only send to the authorizing EMSP
        this.logger.debug(
          `CDR ${cdrDto.id} authorized by partner ${tenantPartner.countryCode}_${tenantPartner.partyId}, targeting them only`,
        );
        await this.cdrsClientApi.request({
          fromCountryCode: cdrDto.country_code!,
          fromPartyId: cdrDto.party_id!,
          toCountryCode: tenantPartner.countryCode!,
          toPartyId: tenantPartner.partyId!,
          httpMethod: HttpMethod.Post,
          schema: OcpiEmptyResponseSchema,
          partnerProfile: tenantPartner.partnerProfileOCPI!,
          body: cdrDto,
        });
      }
    } catch (e) {
      this.logger.error(`broadcastPostCdr failed for CDR ${cdrDto.id}`, e);
    }

    await this.persistCdrRecord(cdrDto, transactionDto);
  }

  private async persistCdrRecord(
    cdr: Cdr,
    transaction: ITransactionDto,
  ): Promise<void> {
    try {
      const variables = buildCdrRecordVariables(cdr, transaction);

      await this.ocpiGraphqlClient.request<
        InsertCdrRecordMutationResult,
        InsertCdrRecordMutationVariables
      >(INSERT_CDR_RECORD_MUTATION, variables);

      this.logger.debug(`Persisted CdrRecord for CDR ${cdr.id}`);
    } catch (e) {
      this.logger.error(
        `Failed to persist CdrRecord for CDR ${cdr.id} — broadcast was still attempted`,
        e,
      );
    }
  }
}
