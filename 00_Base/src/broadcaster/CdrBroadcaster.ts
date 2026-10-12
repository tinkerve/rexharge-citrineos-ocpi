// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { HttpMethod, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { Service } from 'typedi';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import {
  GetCdrRecordByTransactionIdQueryResult,
  GetCdrRecordByTransactionIdQueryVariables,
  InsertCdrRecordMutationResult,
  InsertCdrRecordMutationVariables,
} from '../graphql/operations';
import {
  GET_CDR_RECORD_BY_TRANSACTION_ID_QUERY,
  INSERT_CDR_RECORD_MUTATION,
} from '../graphql/queries/cdr.queries';
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

  // Transactions whose CDR broadcast is under way in this process. The stored
  // CdrRecords row only appears after the partner POST, so two session-end
  // signals handled back to back would both pass the row check without this.
  private readonly inFlight = new Set<number>();

  /**
   * POSTs the session's CDR to the authorising partner and stores it, at most
   * once per transaction: a transaction that already has a CdrRecords row, or
   * whose broadcast is still in flight, is skipped. A session end can be
   * signalled more than once (CitrineOS splits a stop across two Transactions
   * updates, and the connector-Available path can also fire).
   */
  async broadcastPostCdr(transactionDto: ITransactionDto): Promise<void> {
    const transactionId = transactionDto.id;
    if (transactionId == null) {
      return this.postAndPersistCdr(transactionDto);
    }
    if (this.inFlight.has(transactionId)) {
      this.logger.info(
        `CDR broadcast already in flight for Transaction ${transactionId}, skipping duplicate`,
      );
      return;
    }
    this.inFlight.add(transactionId);
    try {
      if (await this.hasStoredCdr(transactionId)) {
        this.logger.info(
          `CdrRecord already exists for Transaction ${transactionId}, skipping duplicate CDR broadcast`,
        );
        return;
      }
      await this.postAndPersistCdr(transactionDto);
    } finally {
      this.inFlight.delete(transactionId);
    }
  }

  // Fails open: a lookup error must not cost the partner their bill, and the
  // insert's cdrId conflict clause still keeps a single stored row.
  private async hasStoredCdr(transactionId: number): Promise<boolean> {
    try {
      const response = await this.ocpiGraphqlClient.request<
        GetCdrRecordByTransactionIdQueryResult,
        GetCdrRecordByTransactionIdQueryVariables
      >(GET_CDR_RECORD_BY_TRANSACTION_ID_QUERY, { transactionId });
      return (response?.CdrRecords?.length ?? 0) > 0;
    } catch (e) {
      this.logger.error(
        `CdrRecord lookup failed for Transaction ${transactionId}, broadcasting anyway`,
        e,
      );
      return false;
    }
  }

  private async postAndPersistCdr(
    transactionDto: ITransactionDto,
  ): Promise<void> {
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
