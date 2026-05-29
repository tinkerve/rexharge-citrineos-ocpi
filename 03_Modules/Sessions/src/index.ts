// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ICache, IConnectorDto, IMeterValueDto, ITransactionDto } from '@citrineos/base';
import {
  AbstractDtoModule,
  AsDtoEventHandler,
  CacheWrapper,
  CdrBroadcaster,
  DtoEventObjectType,
  DtoEventType,
  GET_RECENTLY_ENDED_TRANSACTION_BY_EVSE_QUERY,
  GET_TRANSACTION_BY_ID_QUERY,
  GetRecentlyEndedTransactionByEvseQueryResult,
  GetRecentlyEndedTransactionByEvseQueryVariables,
  GetTransactionByTransactionIdQueryResult,
  GetTransactionByTransactionIdQueryVariables,
  IDtoEvent,
  OcpiConfig,
  OcpiConfigToken,
  OcpiGraphqlClient,
  OcpiModule,
  RabbitMqDtoReceiver,
  SessionBroadcaster,
  UPDATE_TRANSACTION_CUSTOM_DATA_MUTATION,
  UpdateTransactionCustomDataMutationResult,
  UpdateTransactionCustomDataMutationVariables,
  TOKEN_ID_TO_AUTH_REF_CACHE_NAMESPACE,
} from '@citrineos/ocpi-base';
import { ILogObj, Logger } from 'tslog';
import { Inject, Service } from 'typedi';
import { SessionsModuleApi } from './module/SessionsModuleApi';

export { ISessionsModuleApi } from './module/ISessionsModuleApi';
export { SessionsModuleApi } from './module/SessionsModuleApi';

@Service()
export class SessionsModule extends AbstractDtoModule implements OcpiModule {
  private cache: ICache;

  constructor(
    @Inject(OcpiConfigToken) config: OcpiConfig,
    logger: Logger<ILogObj>,
    readonly ocpiGraphqlClient: OcpiGraphqlClient,
    readonly sessionBroadcaster: SessionBroadcaster,
    readonly cdrBroadcaster: CdrBroadcaster,
    @Inject() cacheWrapper: CacheWrapper,
  ) {
    super(config, new RabbitMqDtoReceiver(config, logger), logger);
    this.cache = cacheWrapper.cache;
  }

  getController(): any {
    return SessionsModuleApi;
  }

  async init(): Promise<void> {
    this._logger.info('Initializing Sessions Module...');
    await this._receiver.init();
    this._logger.info('Sessions Module initialized successfully.');
  }

  async shutdown(): Promise<void> {
    this._logger.info('Shutting down Sessions Module...');
    await super.shutdown();
  }

  /**
   * CDR is ready when the session has ended AND we have a confirmed unplug timestamp.
   *
   * For OCPP 2.0.1 sessions ended by EVDisconnected (stoppedReason=EVDisconnected),
   * endTime IS the unplug timestamp — CDR can be sent immediately.
   *
   * For sessions ended by a stop command (Remote, Local, StopAuthorized, etc.),
   * the car may still be physically connected. We wait until the connector returns
   * to Available (StatusNotification → handleConnectorUpdate), which stores
   * unplugTime in customData. Only then is the CDR ready.
   */
  private isReadyForCdrBroadcast(transaction: ITransactionDto): boolean {
    if (transaction.isActive !== false) {
      return false;
    }

    if (!transaction.endTime) {
      return false;
    }

    // OCPP 1.6 path: stopTransaction is populated; endTime is set together with it
    const stopTimeMs = this.toMs(transaction.stopTransaction?.timestamp);
    if (stopTimeMs != null) {
      return this.toMs(transaction.endTime)! >= stopTimeMs;
    }

    // OCPP 2.0.1: if session ended because EV physically disconnected,
    // endTime is already the unplug time — no further waiting needed.
    if (transaction.stoppedReason === 'EVDisconnected') {
      return true;
    }

    // Session was stopped by a command; wait for connector → Available
    // (handleConnectorUpdate sets customData.unplugTime when that happens).
    return transaction.customData?.unplugTime != null;
  }

  private toMs(value: string | null | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }

  /**
   * Checks if a meter value is a Transaction.Begin meter value by comparing timestamps
   */
  private async isTransactionBeginMeterValue(
    meterValueDto: IMeterValueDto,
  ): Promise<boolean> {
    try {
      // Fetch the transaction to get its start time
      const transactionResponse = await this.ocpiGraphqlClient.request<
        GetTransactionByTransactionIdQueryResult,
        GetTransactionByTransactionIdQueryVariables
      >(GET_TRANSACTION_BY_ID_QUERY, {
        id: Number(meterValueDto.transactionId!),
      });

      if (!transactionResponse.Transactions[0]) {
        this._logger.warn(
          `Transaction not found for meter value ${meterValueDto.id}`,
        );
        return false;
      }

      const transaction = transactionResponse.Transactions[0];
      const transactionStartTime = new Date(transaction.startTime);
      const meterValueTime = new Date(meterValueDto.timestamp);

      // Consider it a Transaction.Begin meter value if it's within 1 second of transaction start
      const timeDiffMs = Math.abs(
        meterValueTime.getTime() - transactionStartTime.getTime(),
      );
      return timeDiffMs <= 1000; // 1 second tolerance
    } catch (error) {
      this._logger.error(
        `Error checking if meter value is Transaction.Begin: ${error}`,
      );
      return false;
    }
  }

  @AsDtoEventHandler(
    DtoEventType.INSERT,
    DtoEventObjectType.Transaction,
    'TransactionNotification',
  )
  async handleTransactionInsert(
    event: IDtoEvent<ITransactionDto>,
  ): Promise<void> {
    this._logger.debug(`Handling Transaction Insert: ${JSON.stringify(event)}`);
    const transactionDto = event._payload;
    const tenant = transactionDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${transactionDto.id}, cannot broadcast.`,
      );
      return;
    }

    // Fetch the full transaction with meter values to include Transaction.Begin meter values in the initial PUT
    const fullTransactionResponse = await this.ocpiGraphqlClient.request<
      GetTransactionByTransactionIdQueryResult,
      GetTransactionByTransactionIdQueryVariables
    >(GET_TRANSACTION_BY_ID_QUERY, {
      id: transactionDto.id!,
    });

    const fullTransactionDto = fullTransactionResponse.Transactions[0]
      ? (fullTransactionResponse.Transactions[0] as ITransactionDto)
      : transactionDto;

    // Associate token ID with authorization_reference if available in cache
    if (fullTransactionDto.authorization?.idToken) {
      try {
        const authorizationReference: string | null = await this.cache.get(
          fullTransactionDto.authorization.idToken,
          TOKEN_ID_TO_AUTH_REF_CACHE_NAMESPACE,
        );
        this.cache.remove(
          fullTransactionDto.authorization.idToken,
          TOKEN_ID_TO_AUTH_REF_CACHE_NAMESPACE,
        );

        if (authorizationReference) {
          this._logger.debug(
            `Found authorization_reference ${authorizationReference} for token ${fullTransactionDto.authorization.idToken}`,
          );
          // Store authorization_reference in customData in database
          const customData = fullTransactionDto.customData || {};
          customData.authorization_reference = authorizationReference;

          await this.ocpiGraphqlClient.request<
            UpdateTransactionCustomDataMutationResult,
            UpdateTransactionCustomDataMutationVariables
          >(UPDATE_TRANSACTION_CUSTOM_DATA_MUTATION, {
            id: fullTransactionDto.id!,
            customData,
          });

          // Update the DTO for broadcasting
          fullTransactionDto.customData = customData;

          this._logger.debug(
            `Successfully updated transaction ${fullTransactionDto.id} with authorization_reference in database`,
          );
        } else {
          this._logger.warn(
            `No authorization_reference found in cache for token ${fullTransactionDto.authorization.idToken}`,
          );
        }
      } catch (error) {
        this._logger.error(
          `Error retrieving or updating authorization_reference: ${error}`,
        );
      }
    }

    await this.sessionBroadcaster.broadcastPutSession(
      tenant,
      fullTransactionDto,
    );
  }

  @AsDtoEventHandler(
    DtoEventType.UPDATE,
    DtoEventObjectType.Transaction,
    'TransactionNotification',
  )
  async handleTransactionUpdate(
    event: IDtoEvent<Partial<ITransactionDto>>,
  ): Promise<void> {
    this._logger.debug(`Handling Transaction Update: ${JSON.stringify(event)}`);
    const transactionDto = event._payload;
    const tenant = transactionDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${transactionDto.id}, cannot broadcast.`,
      );
      return;
    }
    await this.sessionBroadcaster.broadcastPatchSession(tenant, transactionDto);

    // Check CDR readiness when session ends (isActive→false) OR when unplug timestamp
    // arrives (endTime set) — the latter covers the "stop first, unplug later" case where
    // isActive is already false in the DB but endTime was not yet present at stop time.
    const shouldCheckCdr =
      transactionDto.isActive === false || transactionDto.endTime != null;

    if (shouldCheckCdr) {
      this._logger.debug(
        `CDR readiness check for transaction ${transactionDto.id} (isActive=${transactionDto.isActive}, endTime=${transactionDto.endTime})`,
      );

      const fullTransactionDtoResponse = await this.ocpiGraphqlClient.request<
        GetTransactionByTransactionIdQueryResult,
        GetTransactionByTransactionIdQueryVariables
      >(GET_TRANSACTION_BY_ID_QUERY, {
        id: transactionDto.id!,
      });

      if (!fullTransactionDtoResponse.Transactions[0]) {
        this._logger.error(
          `Full Transaction DTO not found for ID ${transactionDto.id}, cannot broadcast.`,
        );
        return;
      }

      const fullTransactionDto = fullTransactionDtoResponse
        .Transactions[0] as ITransactionDto;

      if (!this.isReadyForCdrBroadcast(fullTransactionDto)) {
        this._logger.debug(
          `Transaction ${fullTransactionDto.id} not ready for CDR yet (waiting for session end and/or unplug).`,
        );
        return;
      }

      await this.cdrBroadcaster.broadcastPostCdr(fullTransactionDto);
    }
  }

  @AsDtoEventHandler(
    DtoEventType.INSERT,
    DtoEventObjectType.MeterValue,
    'MeterValueNotification',
  )
  async handleMeterValueInsert(
    event: IDtoEvent<IMeterValueDto>,
  ): Promise<void> {
    this._logger.debug(`Handling Meter Value Insert: ${JSON.stringify(event)}`);
    const meterValueDto = event._payload;
    const tenant = meterValueDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${meterValueDto.id}, cannot broadcast.`,
      );
      return;
    }
    if (meterValueDto.transactionId) {
      this._logger.debug(
        `Meter Value belongs to Transaction: ${meterValueDto.transactionId}`,
      );
      if (!meterValueDto.tariffId) {
        this._logger.warn(
          `Tariff ID missing in Meter Value notification for Transaction ${meterValueDto.transactionId}, cannot broadcast.`,
        );
        return;
      }

      // Skip Transaction.Begin meter values to prevent race condition
      const isTransactionBegin =
        await this.isTransactionBeginMeterValue(meterValueDto);
      if (isTransactionBegin) {
        this._logger.debug(
          `Skipping Transaction.Begin meter value for Transaction ${meterValueDto.transactionId} to prevent race condition`,
        );
        return;
      }

      const fullTransactionDtoResponse = await this.ocpiGraphqlClient.request<
        GetTransactionByTransactionIdQueryResult,
        GetTransactionByTransactionIdQueryVariables
      >(GET_TRANSACTION_BY_ID_QUERY, {
        id: Number(meterValueDto.transactionId),
      });
      const fullTransactionDto = fullTransactionDtoResponse.Transactions[0] as
        | ITransactionDto
        | undefined;
      const tenantPartner =
        fullTransactionDto?.authorization?.tenantPartner ?? undefined;

      await this.sessionBroadcaster.broadcastPatchSessionChargingPeriod(
        tenant,
        meterValueDto,
        tenantPartner,
      );
    }
  }

  /**
   * When a connector returns to Available, the car has physically unplugged.
   * For sessions stopped by a command (not EVDisconnected), this is the unplug
   * timestamp we were waiting for. We record it in customData and fire the CDR.
   */
  @AsDtoEventHandler(
    DtoEventType.UPDATE,
    DtoEventObjectType.Connector,
    'ConnectorNotification',
  )
  async handleConnectorUpdate(
    event: IDtoEvent<Partial<IConnectorDto>>,
  ): Promise<void> {
    const connectorDto = event._payload;

    // Only act on transitions to Available (= physical unplug)
    if (connectorDto.status !== 'Available') {
      return;
    }

    if (!connectorDto.evseId || !connectorDto.stationId) {
      return;
    }

    // Find the most recently ended transaction on this EVSE
    const response = await this.ocpiGraphqlClient.request<
      GetRecentlyEndedTransactionByEvseQueryResult,
      GetRecentlyEndedTransactionByEvseQueryVariables
    >(GET_RECENTLY_ENDED_TRANSACTION_BY_EVSE_QUERY, {
      evseId: connectorDto.evseId,
      stationId: connectorDto.stationId,
    });

    const rawTransaction = response.Transactions[0];
    if (!rawTransaction) {
      return;
    }

    // Skip if already ended by EVDisconnected — CDR was already sent at Ended time
    if (rawTransaction.stoppedReason === 'EVDisconnected') {
      return;
    }

    // Skip if unplugTime is already recorded (idempotency guard)
    if (rawTransaction.customData?.unplugTime != null) {
      return;
    }

    // The StatusNotification timestamp on the connector is the charger-clock unplug time.
    // Fall back to updatedAt if timestamp is not present.
    const unplugTime = connectorDto.timestamp ?? connectorDto.updatedAt?.toISOString();
    if (!unplugTime) {
      this._logger.warn(
        `Connector ${connectorDto.id} has no timestamp for unplug event on EVSE ${connectorDto.evseId}`,
      );
      return;
    }

    // Sanity check: unplug must be after or at session end
    const endTimeMs = this.toMs(rawTransaction.endTime);
    const unplugMs = this.toMs(unplugTime);
    if (endTimeMs == null || unplugMs == null || unplugMs < endTimeMs) {
      this._logger.debug(
        `Connector Available timestamp (${unplugTime}) is not after session endTime (${rawTransaction.endTime}) for transaction ${rawTransaction.id}, skipping unplug recording`,
      );
      return;
    }

    // Store unplugTime so CdrMapper can compute post-session parking
    const customData = { ...(rawTransaction.customData ?? {}), unplugTime };
    await this.ocpiGraphqlClient.request<
      UpdateTransactionCustomDataMutationResult,
      UpdateTransactionCustomDataMutationVariables
    >(UPDATE_TRANSACTION_CUSTOM_DATA_MUTATION, {
      id: rawTransaction.id,
      customData,
    });

    // Re-fetch the full transaction (now with unplugTime in customData) and broadcast CDR
    const fullTransactionResponse = await this.ocpiGraphqlClient.request<
      GetTransactionByTransactionIdQueryResult,
      GetTransactionByTransactionIdQueryVariables
    >(GET_TRANSACTION_BY_ID_QUERY, { id: rawTransaction.id });

    const fullTransaction = fullTransactionResponse.Transactions[0] as ITransactionDto | undefined;
    if (!fullTransaction) {
      this._logger.error(`Transaction ${rawTransaction.id} not found after unplug update`);
      return;
    }

    if (!this.isReadyForCdrBroadcast(fullTransaction)) {
      this._logger.debug(`Transaction ${fullTransaction.id} still not ready for CDR after unplug`);
      return;
    }

    await this.cdrBroadcaster.broadcastPostCdr(fullTransaction);
  }
}
