// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  HttpMethod,
  IMeterValueDto,
  ITenantDto,
  ITenantPartnerDto,
  ITransactionDto,
} from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { Service } from 'typedi';
import { SessionMapper } from '../mapper/SessionMapper';
import { OcpiEmptyResponseSchema } from '../model/OcpiEmptyResponse';
import { Session } from '../model/Session';
import { SessionsClientApi } from '../trigger/SessionsClientApi';
import { BaseBroadcaster } from './BaseBroadcaster';

@Service()
export class SessionBroadcaster extends BaseBroadcaster {
  constructor(
    readonly logger: Logger<ILogObj>,
    readonly sessionsClientApi: SessionsClientApi,
    readonly sessionMapper: SessionMapper,
  ) {
    super();
  }

  async broadcastPutSession(
    tenant: ITenantDto,
    transactionDto: ITransactionDto,
  ): Promise<void> {
    const session =
      await this.sessionMapper.mapTransactionToSession(transactionDto);
    const path = `/${tenant.countryCode}/${tenant.partyId}/${session.id}`;
    const tenantPartner =
      transactionDto.authorization?.tenantPartner ?? undefined;
    await this.broadcastSession(
      tenant,
      session,
      HttpMethod.Put,
      path,
      tenantPartner,
    );
  }

  async broadcastPatchSession(
    tenant: ITenantDto,
    transactionDto: Partial<ITransactionDto>,
  ): Promise<void> {
    const session =
      await this.sessionMapper.mapPartialTransactionToPartialSession(
        transactionDto,
      );
    const path = `/${tenant.countryCode}/${tenant.partyId}/${session.id}`;
    const tenantPartner =
      transactionDto.authorization?.tenantPartner ?? undefined;
    await this.broadcastSession(
      tenant,
      session,
      HttpMethod.Patch,
      path,
      tenantPartner,
    );
  }

  async broadcastPatchSessionChargingPeriod(
    tenant: ITenantDto,
    meterValueDto: IMeterValueDto,
  ): Promise<void> {
    const charging_periods = await this.sessionMapper.getChargingPeriods(
      [meterValueDto],
      meterValueDto.tariffId!.toString(),
    );
    const path = `/${tenant.countryCode}/${tenant.partyId}/${meterValueDto.transactionDatabaseId}`;
    await this.broadcastSession(
      tenant,
      { charging_periods },
      HttpMethod.Patch,
      path,
    );
  }

  private async broadcastSession(
    tenant: ITenantDto,
    session: Partial<Session>,
    method: HttpMethod,
    path: string,
    tenantPartner?: ITenantPartnerDto,
  ): Promise<void> {
    try {
      if (tenantPartner) {
        // Session was authorized by a specific EMSP partner — only push to them
        this.logger.debug(
          `Session ${path} authorized by partner ${tenantPartner.countryCode}_${tenantPartner.partyId}, targeting them only`,
        );
        await this.sessionsClientApi.request(
          tenant.countryCode!,
          tenant.partyId!,
          tenantPartner.countryCode!,
          tenantPartner.partyId!,
          method,
          OcpiEmptyResponseSchema,
          tenantPartner.partnerProfileOCPI!,
          true,
          undefined,
          session,
          undefined,
          undefined,
          path,
        );
      }
    } catch (e) {
      this.logger.error(`broadcast${method}Session failed for ${path}`, e);
    }
  }
}
