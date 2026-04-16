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
import { CdrMapper } from '../mapper';
import { Cdr } from '../model/Cdr';
import { InterfaceRole } from '../model/InterfaceRole';
import { ModuleId } from '../model/ModuleId';
import { OcpiEmptyResponseSchema } from '../model/OcpiEmptyResponse';
import { CdrsClientApi } from '../trigger/CdrsClientApi';
import { BaseBroadcaster } from './BaseBroadcaster';

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

    try {
      await this.cdrsClientApi.broadcastToClients({
        cpoCountryCode: cdrDto.country_code!,
        cpoPartyId: cdrDto.party_id!,
        moduleId: ModuleId.Cdrs,
        interfaceRole: InterfaceRole.RECEIVER,
        httpMethod: HttpMethod.Post,
        schema: OcpiEmptyResponseSchema,
        body: cdrDto,
      });
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
      const now = new Date().toISOString();
      const tenantPartnerId =
        transaction.authorization?.tenantPartner?.id ?? undefined;

      const variables: InsertCdrRecordMutationVariables = {
        cdrId: cdr.id,
        transactionId: transaction.id ?? undefined,
        tenantPartnerId,
        ocpiSessionId: cdr.session_id ?? undefined,
        startDateTime: cdr.start_date_time,
        endDateTime: cdr.end_date_time,
        currency: cdr.currency,
        totalEnergy: cdr.total_energy,
        totalTime: cdr.total_time,
        totalParkingTime: cdr.total_parking_time ?? 0,
        totalCostExclVat: cdr.total_cost.excl_vat,
        totalCostInclVat: cdr.total_cost.incl_vat ?? undefined,
        totalEnergyCostExclVat: cdr.total_energy_cost?.excl_vat ?? undefined,
        totalTimeCostExclVat: cdr.total_time_cost?.excl_vat ?? undefined,
        totalParkingCostExclVat: cdr.total_parking_cost?.excl_vat ?? undefined,
        totalFixedCostExclVat: cdr.total_fixed_cost?.excl_vat ?? undefined,
        totalReservationCostExclVat:
          cdr.total_reservation_cost?.excl_vat ?? undefined,
        taxRate: undefined,
        cdrData: cdr as any,
        createdAt: now,
        updatedAt: now,
      };

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
