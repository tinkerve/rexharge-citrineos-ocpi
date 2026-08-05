// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { Service } from 'typedi';
import { Session } from '../model/Session';
import { ITariffDto, OCPP2_0_1 } from '@citrineos/base';
import { AuthMethod } from '../model/AuthMethod';
import { ChargingPeriod } from '../model/ChargingPeriod';
import { CdrDimensionType } from '../model/CdrDimensionType';
import { CdrToken } from '../model/CdrToken';
import { SessionStatus } from '../model/SessionStatus';
import { ILogObj, Logger } from 'tslog';
import { CdrDimension } from '../model/CdrDimension';
import { Price } from '../model/Price';
import { TokenDTO } from '../model/DTO/TokenDTO';
import { BaseTransactionMapper } from './BaseTransactionMapper';
import { LocationsService } from '../services/LocationsService';
import { LocationDTO } from '../model/DTO/LocationDTO';
import { UID_FORMAT } from '../model/DTO/EvseDTO';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import {
  ITransactionDto,
  ITransactionEventDto,
  IMeterValueDto,
} from '@citrineos/base';
import { toISOStringIfNeeded } from '../util/DateTimeHelper';

@Service()
export class SessionMapper extends BaseTransactionMapper {
  constructor(
    protected logger: Logger<ILogObj>,
    protected locationsService: LocationsService,
    protected ocpiGraphqlClient: OcpiGraphqlClient,
  ) {
    super(logger, locationsService, ocpiGraphqlClient);
  }

  /**
   * Maps a single transaction to a session
   */
  public async mapTransactionToSession(
    transaction: ITransactionDto,
  ): Promise<Session> {
    const [locationMap, tokenMap, tariffMap] =
      await this.getLocationsTokensAndTariffsMapsForTransactions([transaction]);

    const location = locationMap.get(transaction.id!.toString());
    const token = tokenMap.get(transaction.id!.toString());
    const tariff = tariffMap.get(transaction.id!.toString());

    if (!location || !token || !tariff) {
      const missing = [];
      if (!location) missing.push('location');
      if (!token) missing.push('token');
      if (!tariff) missing.push('tariff');

      throw new Error(
        `Cannot map transaction ${transaction.id} to session. Missing: ${missing.join(', ')}`,
      );
    }

    return this.mapTransactionWithContextToSession(
      transaction,
      location,
      token,
      tariff,
    );
  }

  /**
   * Maps a partial transaction to a partial session
   */
  public async mapPartialTransactionToPartialSession(
    transaction: Partial<ITransactionDto>,
  ): Promise<Partial<Session>> {
    // If we don't have a transaction ID, we can only map basic fields
    if (!transaction.id) {
      return this.mapPartialTransactionWithoutContext(transaction);
    }

    try {
      // Try to fetch context data, but handle failures gracefully
      const [locationMap, tokenMap, tariffMap] =
        await this.getLocationsTokensAndTariffsMapsForTransactions([
          transaction as ITransactionDto,
        ]);

      const location = locationMap.get(transaction.id.toString());
      const token = tokenMap.get(transaction.id.toString());
      const tariff = tariffMap.get(transaction.id.toString());

      return this.mapPartialTransactionWithContext(
        transaction,
        location,
        token,
        tariff,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to fetch context for partial transaction ${transaction.id}. Mapping without context.`,
        error,
      );
      return this.mapPartialTransactionWithoutContext(transaction);
    }
  }

  /**
   * Builds the in-session progress PATCH sent on every meter value
   * (OCPI 2.2.1 Sessions, "update charging period" example):
   *
   *   { kwh, charging_periods: [...], total_cost, last_updated }
   *
   * charging_periods carries the session's *full* period history, not just the
   * newly observed one. OCPI defines no merge rule for arrays, so a receiver
   * may replace rather than append: our own eMSP does exactly that
   * (SessionsService.patchSession assigns charging_periods wholesale) and then
   * sums every period to derive the live cost, so sending one period would
   * collapse its running total to a single interval. A full array is correct
   * under replace and under upsert-by-start_date_time; only blind append would
   * duplicate, and nothing in either implementation does that.
   *
   * Periods with no dimensions are dropped, and charging_periods is omitted
   * entirely when none survive — an empty array would clear what the receiver
   * already holds.
   */
  public async mapMeterValueToProgressPatch(
    transaction: ITransactionDto,
    meterValue: IMeterValueDto,
  ): Promise<Partial<Session>> {
    const tariffMap = await this.getTariffsForTransactions([transaction]);
    const tariff = tariffMap.get(transaction.id!.toString());

    const session: Partial<Session> = {
      kwh: transaction.totalKwh || 0,
      last_updated: this.getProgressLastUpdated(transaction, meterValue),
    };

    if (tariff) {
      session.total_cost = this.computeRunningCost(
        transaction,
        tariff,
        meterValue.timestamp,
      );
    }

    const periods = this.getChargingPeriods(
      this.withMeterValue(transaction.meterValues, meterValue),
      tariff ? String(tariff.id) : undefined,
    );
    if (periods.length > 0) {
      session.charging_periods = periods;
    } else {
      this.logger.debug(
        `Transaction ${transaction.id} has no charging periods with dimensions yet; sending progress PATCH without charging_periods`,
      );
    }

    return session;
  }

  /**
   * Builds the cost-only PATCH (OCPI 2.2.1 Sessions, "update total_cost" example):
   *
   *   { total_cost, last_updated }
   *
   * Sent when the running cost moves without a new meter value — e.g. a
   * CostNotifier tick writing Transactions.totalCost while the car idles.
   */
  public async mapTransactionToCostPatch(
    transaction: ITransactionDto,
  ): Promise<Partial<Session> | undefined> {
    const tariffMap = await this.getTariffsForTransactions([transaction]);
    const tariff = tariffMap.get(transaction.id!.toString());
    if (!tariff) {
      this.logger.warn(
        `No tariff for transaction ${transaction.id}; cannot build cost PATCH`,
      );
      return undefined;
    }

    const asOf = transaction.updatedAt ?? new Date();
    return {
      total_cost: this.computeRunningCost(transaction, tariff, asOf),
      last_updated: toISOStringIfNeeded(asOf),
    };
  }

  /**
   * Running cost of a live session, using the same energy + time + fixed
   * components (and VAT) as the final CDR, so the in-app running total
   * converges on the receipt instead of drifting below it.
   */
  private computeRunningCost(
    transaction: ITransactionDto,
    tariff: ITariffDto,
    asOf: Date | string,
  ): Price {
    const energyCost = this.computeEnergyCost(
      transaction.totalKwh || 0,
      tariff,
    );
    const timeCost = this.computeTimeCost(
      this.elapsedHours(transaction, asOf),
      tariff,
    );
    const fixedCost = this.computeFixedCost(tariff);
    return this.sumCosts([energyCost, timeCost, fixedCost], tariff);
  }

  /**
   * Hours elapsed between session start and `asOf`. The CDR bills TIME over
   * the full session duration (CdrMapper.calculateTotalTime), so the live
   * equivalent is start → now.
   */
  private elapsedHours(
    transaction: ITransactionDto,
    asOf: Date | string,
  ): number {
    const start = transaction.startTime ?? transaction.createdAt;
    if (!start) return 0;
    const elapsedMs = new Date(asOf).getTime() - new Date(start).getTime();
    return elapsedMs > 0 ? elapsedMs / 3600000 : 0;
  }

  /**
   * `last_updated` must advance on every PATCH or the eMSP discards it as
   * stale. Transactions.updatedAt does not move when a meter value carries no
   * energy delta (the TransactionNotify trigger skips no-op updates), so take
   * whichever of the two timestamps is later.
   */
  private getProgressLastUpdated(
    transaction: ITransactionDto,
    meterValue: IMeterValueDto,
  ): string {
    const candidates = [meterValue.timestamp, transaction.updatedAt]
      .filter((value): value is Date | string => value != null)
      .map((value) => new Date(value).getTime())
      .filter((ms) => !Number.isNaN(ms));
    const latest = candidates.length ? Math.max(...candidates) : Date.now();
    return toISOStringIfNeeded(new Date(latest))!;
  }

  /**
   * The re-hydrated transaction is fetched over GraphQL right after the insert
   * that triggered this event, so the triggering meter value is normally
   * already in `meterValues`. Merge it in defensively: if a read lag ever hid
   * it, the PATCH would otherwise omit the very period that prompted it.
   */
  private withMeterValue(
    meterValues: IMeterValueDto[] = [],
    meterValue: IMeterValueDto,
  ): IMeterValueDto[] {
    const alreadyPresent = meterValues.some((candidate) =>
      candidate.id != null && meterValue.id != null
        ? candidate.id === meterValue.id
        : new Date(candidate.timestamp).getTime() ===
          new Date(meterValue.timestamp).getTime(),
    );
    return alreadyPresent ? [...meterValues] : [...meterValues, meterValue];
  }

  public async getLocationsTokensAndTariffsMapsForTransactions(
    transactions: ITransactionDto[],
  ): Promise<
    [Map<string, LocationDTO>, Map<string, TokenDTO>, Map<string, ITariffDto>]
  > {
    return await Promise.all([
      this.getLocationDTOsForTransactions(transactions),
      this.getTokensForTransactions(transactions),
      this.getTariffsForTransactions(transactions),
    ]);
  }

  public async mapTransactionsToSessions(
    transactions: ITransactionDto[],
  ): Promise<Session[]> {
    const [
      transactionIdToLocationMap,
      transactionIdToTokenMap,
      transactionIdToTariffMap,
    ] =
      await this.getLocationsTokensAndTariffsMapsForTransactions(transactions);
    return await this.mapTransactionsToSessionsHelper(
      transactions,
      transactionIdToLocationMap,
      transactionIdToTokenMap,
      transactionIdToTariffMap,
    );
  }

  public async mapTransactionsToSessionsHelper(
    transactions: ITransactionDto[],
    transactionIdToLocationMap: Map<string, LocationDTO>,
    transactionIdToTokenMap: Map<string, TokenDTO>,
    transactionIdToTariffMap: Map<string, ITariffDto>,
  ): Promise<Session[]> {
    const result: Session[] = [];
    for (const transaction of transactions) {
      const location = transactionIdToLocationMap.get(
        transaction.id!.toString(),
      );
      const token = transactionIdToTokenMap.get(transaction.id!.toString());
      const tariff = transactionIdToTariffMap.get(transaction.id!.toString());

      if (location && token && tariff) {
        result.push(
          this.mapTransactionWithContextToSession(
            transaction,
            location,
            token,
            tariff,
          ),
        );
      } else {
        this.logger.debug(`Skipped transaction ${transaction.id}`);
      }
    }
    return result;
  }

  /**
   * Maps a partial transaction with available context data
   */
  private mapPartialTransactionWithContext(
    transaction: Partial<ITransactionDto>,
    location?: LocationDTO,
    token?: TokenDTO,
    tariff?: ITariffDto,
  ): Partial<Session> {
    const session: Partial<Session> = {};

    // Map basic transaction fields
    if (transaction.id !== undefined) {
      session.id = transaction.id.toString();
    }

    if (transaction.startTime !== undefined) {
      session.start_date_time = transaction.startTime
        ? toISOStringIfNeeded(transaction.startTime)
        : undefined;
    }

    if (transaction.endTime !== undefined) {
      session.end_date_time = this.getSessionEndDateTime(transaction);
    }

    if (transaction.totalKwh !== undefined) {
      session.kwh = transaction.totalKwh || 0;
    }

    if (transaction.updatedAt !== undefined) {
      session.last_updated = toISOStringIfNeeded(transaction.updatedAt);
    }

    // Map context-dependent fields if available
    session.country_code = transaction.tenant!.countryCode!;
    session.party_id = transaction.tenant!.partyId!;

    if (transaction.locationId) {
      session.location_id = transaction.locationId.toString();
    }

    if (token) {
      session.cdr_token = this.createCdrToken(token);
    }

    if (tariff) {
      session.currency = tariff.currency;
      if (transaction.totalKwh !== undefined) {
        session.total_cost = this.calculateTotalCost(
          transaction.totalKwh || 0,
          tariff.pricePerKwh,
        );
      }
    }

    // Map fields that depend on transaction structure
    if (transaction.evseId && transaction.stationId) {
      session.evse_uid = this.getEvseUid(transaction as ITransactionDto);
    }

    if (transaction.connectorId) {
      session.connector_id = transaction.connectorId.toString();
    }

    // Map meter values if available
    if (transaction.meterValues && tariff) {
      session.charging_periods = this.getChargingPeriods(
        transaction.meterValues,
        String(tariff.id),
      );
    }

    // Map status if we can determine it
    if (transaction.endTime !== undefined) {
      session.status = this.getTransactionStatus(
        transaction as ITransactionDto,
      );
    }

    // Set default auth method
    session.auth_method = AuthMethod.WHITELIST;

    // Set optional fields that are typically null in your implementation
    session.authorization_reference =
      transaction.customData?.authorization_reference || undefined;
    session.meter_id = null;

    return session;
  }

  /**
   * Maps a partial transaction without context data (location, token, tariff)
   */
  private mapPartialTransactionWithoutContext(
    transaction: Partial<ITransactionDto>,
  ): Partial<Session> {
    const session: Partial<Session> = {};

    if (transaction.id !== undefined) {
      session.id = transaction.id.toString();
    }

    if (transaction.startTime !== undefined) {
      session.start_date_time = transaction.startTime
        ? toISOStringIfNeeded(transaction.startTime)
        : undefined;
    }

    if (transaction.endTime !== undefined) {
      session.end_date_time = this.getSessionEndDateTime(transaction);
    }

    if (transaction.totalKwh !== undefined) {
      session.kwh = transaction.totalKwh || 0;
    }

    if (transaction.updatedAt !== undefined) {
      session.last_updated = toISOStringIfNeeded(transaction.updatedAt);
    }

    if (transaction.evseId && transaction.stationId) {
      session.evse_uid = this.getEvseUid(transaction as ITransactionDto);
    }

    if (transaction.connectorId) {
      session.connector_id = transaction.connectorId.toString();
    }

    if (transaction.endTime !== undefined) {
      session.status = this.getTransactionStatus(
        transaction as ITransactionDto,
      );
    }

    // Set defaults for fields that don't depend on external context
    session.auth_method = AuthMethod.WHITELIST;
    session.authorization_reference =
      transaction.customData?.authorization_reference || undefined;
    session.meter_id = null;

    return session;
  }

  private mapTransactionWithContextToSession(
    transaction: ITransactionDto,
    location: LocationDTO,
    token: TokenDTO,
    tariff: ITariffDto,
  ): Session {
    return {
      country_code: location.country_code,
      party_id: location.party_id,
      id: transaction.id!.toString(),
      start_date_time: transaction.startTime
        ? toISOStringIfNeeded(transaction.startTime, true)
        : (() => {
            this.logger.error(
              `Transaction ${transaction.id} has no startTime. Using createdAt as placeholder.`,
            );
            return toISOStringIfNeeded(transaction.createdAt!, true);
          })(),
      end_date_time: this.getSessionEndDateTime(transaction),
      kwh: transaction.totalKwh || 0,
      cdr_token: this.createCdrToken(token),
      // TODO: Implement other auth methods
      auth_method: AuthMethod.WHITELIST,
      location_id: this.getLocationId(location),
      evse_uid: this.getEvseUid(transaction),
      connector_id: transaction.connectorId!.toString(),
      currency: tariff.currency,
      charging_periods: this.getChargingPeriods(
        transaction.meterValues,
        String(tariff?.id),
      ),
      status: this.getTransactionStatus(transaction),
      last_updated: toISOStringIfNeeded(transaction.updatedAt!, true),
      authorization_reference: transaction.customData
        ? transaction.customData?.authorization_reference
        : null,
      total_cost: transaction.endTime
        ? this.calculateTotalCost(transaction.totalKwh || 0, tariff.pricePerKwh)
        : {
            excl_vat: 0,
          },
      meter_id: null,
    };
  }

  private getLatestEvent(transactionEvents: ITransactionEventDto[]): Date {
    return transactionEvents.reduce((latestDate, current) => {
      const currentDate = new Date(current.timestamp);
      if (!latestDate || currentDate > latestDate) {
        return currentDate;
      }
      return latestDate;
    }, new Date(transactionEvents[0].timestamp));
  }

  private createCdrToken(token: TokenDTO): CdrToken {
    return {
      uid: token?.uid,
      type: token?.type,
      contract_id: token?.contract_id,
      country_code: token?.country_code,
      party_id: token?.party_id,
    };
  }

  private getLocationId(location: LocationDTO) {
    if (!location.id) {
      this.logger.warn(`Location missing for location ${location.id}`);
    }

    return location.id ?? '';
  }

  private getEvseUid(transaction: ITransactionDto): string {
    return UID_FORMAT(transaction.stationId, transaction.evseId!);
  }

  private getCurrency(location: LocationDTO): string {
    switch (location.country_code) {
      case 'US':
      default:
        return '';
    }
  }

  public getChargingPeriods(
    meterValues: IMeterValueDto[] = [],
    tariffId: string | undefined,
  ): ChargingPeriod[] {
    return meterValues
      .sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      )
      .map((meterValue, index, sortedMeterValues) => {
        const previousMeterValue =
          index > 0 ? sortedMeterValues[index - 1] : undefined;
        return this.mapMeterValueToChargingPeriod(
          meterValue,
          tariffId,
          previousMeterValue,
        );
      })
      // ChargingPeriod.dimensions is 1..* per OCPI 2.2.1 (and min(1) in
      // ChargingPeriodSchema). The first meter value of a session has no
      // predecessor to diff the energy register against, so it yields no
      // dimensions and must not be emitted.
      .filter((period) => period.dimensions.length > 0);
  }

  private mapMeterValueToChargingPeriod(
    meterValue: IMeterValueDto,
    tariffId: string | undefined,
    previousMeterValue?: IMeterValueDto,
  ): ChargingPeriod {
    return {
      start_date_time: toISOStringIfNeeded(meterValue.timestamp, true),
      dimensions: this.getCdrDimensions(meterValue, previousMeterValue),
      tariff_id: tariffId,
    };
  }

  private getCdrDimensions(
    meterValue: IMeterValueDto,
    previousMeterValue?: IMeterValueDto,
  ): CdrDimension[] {
    const cdrDimensions: CdrDimension[] = [];
    for (const sampledValue of meterValue.sampledValue) {
      if (
        sampledValue.measurand ===
          OCPP2_0_1.MeasurandEnumType.Energy_Active_Import_Register &&
        !sampledValue.phase
      ) {
        const previousEnergyImport =
          this.getEnergyImportForMeterValue(previousMeterValue);
        if (
          previousEnergyImport !== undefined &&
          !isNaN(Number(previousEnergyImport)) &&
          !isNaN(Number(sampledValue.value))
        ) {
          const energyDelta =
            Number(sampledValue.value) - Number(previousEnergyImport);
          cdrDimensions.push({
            type: CdrDimensionType.ENERGY,
            volume: this.convertToKwh(energyDelta, (sampledValue as any).unit ?? (sampledValue as any).unitOfMeasure?.unit),
          });
        }
      }
    }
    return cdrDimensions;
  }

  private convertToKwh(value: number, unit?: string | null): number {
    switch (unit) {
      case 'Wh':
        return value / 1000;
      case 'kWh':
        return value;
      default:
        this.logger.warn(`Unknown energy unit "${unit}", assuming Wh`);
        return value / 1000;
    }
  }

  private getEnergyImportForMeterValue(meterValue?: IMeterValueDto) {
    return (
      meterValue?.sampledValue.find(
        (sampledValue) =>
          sampledValue.measurand ===
            OCPP2_0_1.MeasurandEnumType.Energy_Active_Import_Register &&
          !sampledValue.phase,
      )?.value ?? undefined
    );
  }


  private getSessionEndDateTime(transaction: Partial<ITransactionDto>): string | null {
    if (!transaction.endTime) return null;
    // Physical disconnect: endTime IS the unplug time (both OCPP 1.6 and 2.0.1)
    if (transaction.stoppedReason === 'EVDisconnected') return toISOStringIfNeeded(transaction.endTime) ?? null;
    // All other stops: session ends when the car physically disconnects (Available → unplugTime)
    const unplugTime = transaction.customData?.unplugTime;
    if (unplugTime) return toISOStringIfNeeded(unplugTime) ?? null;
    // Charging stopped but car still connected — no session end yet
    return null;
  }

  private getTransactionStatus(transaction: ITransactionDto): SessionStatus {
    if (!transaction.endTime) return SessionStatus.ACTIVE;
    if (transaction.stoppedReason === 'EVDisconnected') return SessionStatus.COMPLETED;
    if (transaction.customData?.unplugTime) return SessionStatus.COMPLETED;
    // Charging stopped but car still connected (parking) — session still active
    return SessionStatus.ACTIVE;
  }
}
