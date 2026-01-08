// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { BaseBroadcaster } from './BaseBroadcaster';
import { Service } from 'typedi';
import { CdrsClientApi } from '../trigger/CdrsClientApi';
import { ILogObj, Logger } from 'tslog';
import { Cdr } from '../model/Cdr';
import { ModuleId } from '../model/ModuleId';
import { InterfaceRole } from '../model/InterfaceRole';
import { HttpMethod, ITransactionDto } from '@citrineos/base';
import { CdrMapper } from '../mapper';
import { OcpiEmptyResponseSchema } from '../model/OcpiEmptyResponse';
import { ExternalDatabaseService } from '../services/ExternalDatabaseService';

@Service()
export class CdrBroadcaster extends BaseBroadcaster {
  constructor(
    readonly logger: Logger<ILogObj>,
    readonly cdrMapper: CdrMapper,
    readonly cdrsClientApi: CdrsClientApi,
    readonly externalDatabaseService: ExternalDatabaseService,
  ) {
    super();
  }

  async broadcastPostCdr(transactionDto: ITransactionDto): Promise<void> {
    const cdrs: Cdr[] = await this.cdrMapper.mapTransactionsToCdrs([
      transactionDto,
    ]);
    if (cdrs.length === 0) {
      this.logger.warn(
        `No CDRs generated for Transaction: ${transactionDto.transactionId}`,
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

      // // Insert record into rexharge database after successful broadcast
      // await this.insertExtendedTransactionRecord(transactionDto, cdrDto);
    } catch (e) {
      this.logger.error(`broadcastPostCdr failed for CDR ${cdrDto.id}`, e);
    }
  }

  // private async insertExtendedTransactionRecord(
  //   transactionDto: ITransactionDto,
  //   cdrDto: Cdr,
  // ): Promise<void> {
  //   try {
  //     // Generate UUID for the record
  //     const { randomUUID } = await import('crypto');
  //     const id = randomUUID();

  //     // Extract authorization to get user_id and vehicle_id
  //     // Note: You'll need to adjust these based on your actual data structure
  //     // TODO: Map actual user_id and vehicle_id from your transaction data
  //     const userId = transactionDto.authorization || null;
  //     const vehicleId = transactionDto.authorization || null; // Adjust this based on where vehicle ID is stored

  //     if (!userId || !vehicleId) {
  //       this.logger.warn(
  //         `Missing user_id or vehicle_id for transaction ${transactionDto.transactionId}. Skipping extended transaction record.`,
  //       );
  //       return;
  //     }

  //     // Calculate meter values from charging periods if available
  //     let meterStartValue = 0;
  //     let meterEndValue = 0;

  //     if (cdrDto.charging_periods && cdrDto.charging_periods.length > 0) {
  //       const energyDimensions = cdrDto.charging_periods.flatMap((period) =>
  //         period.dimensions.filter((dim) => dim.type === 'ENERGY_IMPORT'),
  //       );

  //       if (energyDimensions.length > 0) {
  //         meterStartValue = Math.floor(energyDimensions[0].volume);
  //         meterEndValue = Math.floor(
  //           energyDimensions[energyDimensions.length - 1].volume,
  //         );
  //       }
  //     }

  //     // Determine payment method based on tariff or transaction data
  //     // Default to 'PER_KWH' if not specified
  //     const method = 'PER_KWH';

  //     // Insert the record
  //     await this.externalDatabaseService.insert(
  //       'citrine_extended_transaction',
  //       {
  //         id,
  //         user_id: userId,
  //         vehicle_id: vehicleId,
  //         citrine_transaction_id: parseInt(transactionDto.transactionId!),
  //         method,
  //         idle_rate: 0,
  //         in_session_idle_duration_ms: null,
  //         idle_cost: 0,
  //         discount: 0,
  //         e_coin_deduction: 0,
  //         total_cost_with_idle: cdrDto.total_cost.excl_vat,
  //         invoice_no: cdrDto.invoice_reference_id || null,
  //         payment_status: 'Later',
  //         meter_start_value: meterStartValue,
  //         meter_end_value: meterEndValue,
  //         post_session_idle_duration_ms: null,
  //         total_idle_duration_ms: null,
  //       },
  //     );

  //     this.logger.info(
  //       `Successfully inserted extended transaction record for transaction ${transactionDto.transactionId}`,
  //     );
  //   } catch (error) {
  //     this.logger.error(
  //       `Failed to insert extended transaction record for transaction ${transactionDto.transactionId}`,
  //       error,
  //     );
  //     // Don't throw - we don't want to fail the CDR broadcast if database insertion fails
  //   }
  // }
}
