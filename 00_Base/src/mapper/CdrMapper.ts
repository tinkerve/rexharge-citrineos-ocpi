// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITariffDto, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { Service } from 'typedi';
import {
  GetStatusNotificationsInRangeQueryResult,
  GetStatusNotificationsInRangeQueryVariables,
} from '../graphql/operations';
import { GET_STATUS_NOTIFICATIONS_IN_RANGE } from '../graphql/queries';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { Cdr } from '../model/Cdr';
import { CdrDimensionType } from '../model/CdrDimensionType';
import { CdrLocation } from '../model/CdrLocation';
import { LocationDTO } from '../model/DTO/LocationDTO';
import { Session } from '../model/Session';
import { SignedData } from '../model/SignedData';
import { Tariff as OcpiTariff } from '../model/Tariff';
import { Price } from '../model/Price';
import { LocationsService } from '../services/LocationsService';
import {
  getBillingIdleBufferMinutes,
  getBillingIdleRatePerMin,
  MINUTES_IN_HOUR,
} from '../util/Consts';
import { toISOStringIfNeeded } from '../util/DateTimeHelper';
import { BaseTransactionMapper } from './BaseTransactionMapper';
import { SessionMapper } from './SessionMapper';

@Service()
export class CdrMapper extends BaseTransactionMapper {
  constructor(
    protected logger: Logger<ILogObj>,
    protected locationsService: LocationsService,
    protected ocpiGraphqlClient: OcpiGraphqlClient,
    readonly sessionMapper: SessionMapper,
  ) {
    super(logger, locationsService, ocpiGraphqlClient);
  }

  public async mapTransactionsToCdrs(
    transactions: ITransactionDto[],
  ): Promise<Cdr[]> {
    try {
      const validTransactions = this.getCompletedTransactions(transactions);
      const transactionIdToTransactionMap = new Map<string, ITransactionDto>(
        validTransactions
          .filter((transaction) => transaction.id !== undefined)
          .map((transaction) => [transaction.id!.toString(), transaction]),
      );

      const sessions = await this.mapTransactionsToSessions(validTransactions);

      const [transactionIdToTariffMap, transactionIdToLocationMap] =
        await Promise.all([
          this.getTariffsForTransactions(validTransactions),
          this.getLocationDTOsForTransactions(transactions),
        ]);
      const transactionIdToOcpiTariffMap: Map<string, OcpiTariff> =
        await this.getOcpiTariffsForTransactions(
          sessions,
          transactionIdToTariffMap,
        );
      return await this.mapSessionsToCDRs(
        sessions,
        transactionIdToTransactionMap,
        transactionIdToLocationMap,
        transactionIdToTariffMap,
        transactionIdToOcpiTariffMap,
      );
    } catch (error) {
      // Log the original error for debugging
      this.logger.error('Error mapping transactions to CDRs', { error });

      // Preserve the original error context while providing a clear message
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to map transactions to CDRs: ${errorMessage}`);
    }
  }

  private async mapTransactionsToSessions(
    transactions: ITransactionDto[],
  ): Promise<Session[]> {
    return this.sessionMapper.mapTransactionsToSessions(transactions);
  }

  private async mapSessionsToCDRs(
    sessions: Session[],
    transactionIdToTransactionMap: Map<string, ITransactionDto>,
    transactionIdToLocationMap: Map<string, LocationDTO>,
    transactionIdToTariffMap: Map<string, ITariffDto>,
    transactionIdToOcpiTariffMap: Map<string, OcpiTariff>,
  ): Promise<Cdr[]> {
    return Promise.all(
      sessions
        .filter((session) => transactionIdToTariffMap.has(session.id))
        .map((session) =>
          this.mapSessionToCDR(
            session,
            transactionIdToTransactionMap.get(session.id),
            transactionIdToLocationMap.get(session.id)!,
            transactionIdToTariffMap.get(session.id)!,
            transactionIdToOcpiTariffMap.get(session.id)!,
          ),
        ),
    );
  }

  private async mapSessionToCDR(
    session: Session,
    transaction: ITransactionDto | undefined,
    location: LocationDTO,
    tariff: ITariffDto,
    ocpiTariff: OcpiTariff,
  ): Promise<Cdr> {
    const totalEnergy = session.kwh;
    const totalTime = this.calculateTotalTime(session);
    const totalParkingTime = await this.calculateTotalParkingTime(
      session,
      transaction,
    );

    // OCPI defines total_time_cost as "the cost related to duration of
    // charging", and total_charging_time = total_time - total_parking_time.
    // Pricing on charging time rather than total time is what keeps a warm-up
    // or a stalled charger off the bill: that span is parking by definition
    // (no energy transferred), so it drops out here without needing the
    // reported durations to be trimmed.
    // Fail closed. Without meter readings we cannot tell charging from parking,
    // and every fallback in that state resolves toward billing more: parking
    // falls back to self-reported status, and the whole wall clock prices as
    // charging. On a time-only tariff that is a full invoice for a session we
    // cannot prove delivered anything, so charge nothing instead.
    const energyConfirmed = transaction
      ? this.hasEnergyConfirmation(transaction)
      : false;

    const totalChargingTime = energyConfirmed
      ? Math.max(this.round4(totalTime - totalParkingTime), 0)
      : 0;

    // Only post-charging hogging is chargeable, never the warm-up or a stall.
    const billableParkingTime = transaction
      ? this.calculateBillablePostChargingIdle(session, transaction)
      : 0;

    const totalEnergyCost = this.computeEnergyCost(totalEnergy, tariff);
    const totalTimeCost = this.computeTimeCost(totalChargingTime, tariff);
    const totalFixedCost = this.computeFixedCost(tariff);
    const totalParkingCost = this.computeParkingCost(
      billableParkingTime,
      transaction?.stationId,
      tariff,
    );

    const totalCost = this.sumCosts(
      [totalEnergyCost, totalTimeCost, totalFixedCost, totalParkingCost],
      tariff,
    );

    return {
      country_code: session.country_code,
      party_id: session.party_id,
      id: this.generateCdrId(session),
      start_date_time: toISOStringIfNeeded(session.start_date_time, true),
      end_date_time: toISOStringIfNeeded(session.end_date_time, true),
      session_id: session.id,
      cdr_token: session.cdr_token,
      auth_method: session.auth_method,
      authorization_reference: session.authorization_reference,
      cdr_location: await this.createCdrLocation(location, session),
      meter_id: session.meter_id,
      currency: session.currency,
      tariffs: [ocpiTariff],
      charging_periods: session.charging_periods || [],
      signed_data: await this.getSignedData(session),
      total_cost: totalCost,
      total_fixed_cost: totalFixedCost,
      total_energy: totalEnergy,
      total_energy_cost: totalEnergyCost,
      total_time: totalTime,
      total_time_cost: totalTimeCost,
      total_parking_time: totalParkingTime,
      total_parking_cost: totalParkingCost,
      total_reservation_cost: undefined,
      remark: this.generateRemark(session),
      invoice_reference_id: await this.generateInvoiceReferenceId(session),
      credit: this.isCredit(session, tariff),
      credit_reference_id: this.generateCreditReferenceId(session, tariff),
      last_updated: toISOStringIfNeeded(session.last_updated, true),
    };
  }

  /**
   * OCPI total_parking_time: "Total duration of the charging session where the
   * EV was not charging (no energy was transferred between EVSE and EV)."
   *
   * Three sources, and we take the largest rather than the first available:
   *  - explicit PARKING_TIME from charging periods (currently always 0)
   *  - idle statuses from StatusNotifications (see calculateNonChargingHours)
   *  - the meter itself (see calculateNonChargingHoursFromMeterValues)
   *
   * The meter source is load-bearing. Status is self-reported and can be wrong
   * in the exact case that matters: EVSE fe50ec85 reported Charging across
   * three sessions while transferring 0.000 kWh. Trusting status alone there
   * yields zero parking time, and since total_time_cost prices
   * total_time - total_parking_time, the whole dead session would be billed as
   * charging. The register is the only witness that cannot claim energy moved
   * when it did not.
   *
   * DO NOT price this figure as an idle fee. It deliberately spans two things
   * that are commercially opposite:
   *   - warm-up and mid-session stalls, where the charger is at fault and the
   *     driver owes nothing;
   *   - post-session hogging, where the driver is at fault and an idle rate is
   *     legitimate.
   * OCPI lumps both under "no energy was transferred", and the spec identity
   * total_charging_time = total_time - total_parking_time only holds if we
   * report it that way.
   *
   * This is a live hazard, not a hypothetical one. An idle rate is already
   * configured per location on the gateway side — location 3, the one shared
   * with our roaming partner and holding station 55102-002, carries
   * idle_rate 0.50/min behind a 30 minute buffer, alongside the same
   * pricePerMin 0.60 that CPO tariff 35 publishes. That idle rate is
   * deliberately NOT published over OCPI today: ITariffDto has no parking rate
   * field, TariffMapper emits no PARKING_TIME component, and
   * total_parking_cost is undefined.
   *
   * When that idle rate is wired into OCPI, it must be applied to
   * post-charging idle alone — the span after the last meter value that
   * advanced, minus the configured buffer — and never to this total. Pricing
   * this total instead would bill the driver for a charger that never started,
   * which is the exact defect this file's energy gate exists to prevent.
   */
  private async calculateTotalParkingTime(
    session: Session,
    transaction?: ITransactionDto,
  ): Promise<number> {
    const explicitParkingHours =
      this.calculateTotalParkingTimeFromPeriods(session);
    const nonChargingHours = await this.calculateNonChargingHours(
      session,
      transaction,
      explicitParkingHours,
    );
    const statusDerived = explicitParkingHours + nonChargingHours;

    const meterDerived = transaction
      ? this.calculateNonChargingHoursFromMeterValues(session, transaction)
      : 0;

    return this.round4(Math.max(statusDerived, meterDerived));
  }

  /**
   * Chargeable idle, in hours: the span from when the car finished drawing
   * energy to when it was physically unplugged, less the free buffer.
   *
   * This is deliberately NOT total_parking_time. That figure spans everything
   * where no energy moved, including the warm-up and any mid-session stall —
   * spans the charger is responsible for, which must stay free. Only the tail
   * after the last advancing meter value is the driver occupying a connector
   * they have finished using.
   *
   * Returns 0 when the session never charged: a car that plugged into a dead
   * charger and left is not hogging.
   */
  private calculateBillablePostChargingIdle(
    session: Session,
    transaction: ITransactionDto,
  ): number {
    if (!this.hasEnergyConfirmation(transaction)) return 0;

    const readings = this.getEnergyReadings(transaction);
    if (readings.length < 2) return 0;

    // Last reading whose register actually advanced — charging stopped here.
    let lastAdvanceMs: number | undefined;
    for (let i = 1; i < readings.length; i++) {
      if (this.registerAdvanced(readings[i - 1].kwh, readings[i].kwh)) {
        lastAdvanceMs = readings[i].timestampMs;
      }
    }
    if (lastAdvanceMs == null) return 0;

    const unplugMs = this.toMs(
      transaction.customData?.unplugTime ??
        transaction.endTime ??
        session.end_date_time,
    );
    if (unplugMs == null) return 0;

    const idleMs = unplugMs - lastAdvanceMs;
    const bufferMs =
      getBillingIdleBufferMinutes(transaction.stationId) * 60 * 1000;

    return this.round4(Math.max(idleMs - bufferMs, 0) / 3600000);
  }

  /**
   * Parking cost, priced per minute from the station's configured idle rate.
   *
   * Returns undefined when no rate is configured, which leaves total_parking_cost
   * absent exactly as before — the rate is opt-in per station.
   */
  private computeParkingCost(
    billableIdleHours: number,
    stationId: string | undefined,
    tariff: ITariffDto,
  ): Price | undefined {
    const ratePerMin = getBillingIdleRatePerMin(stationId);
    if (!ratePerMin || billableIdleHours <= 0) return undefined;

    const excl_vat = this.round4(
      billableIdleHours * MINUTES_IN_HOUR * ratePerMin,
    );
    return this.buildPrice(excl_vat, tariff.taxRate);
  }

  /**
   * Non-charging hours measured from the energy register: any interval between
   * consecutive meter values whose energy did not advance is time the EV was
   * not charging, which is precisely OCPI's definition of parking time.
   *
   * Also covers the head of the session — the span from session start to the
   * first meter reading — since no energy can have been transferred before the
   * first sample. On production hardware that alone is about a minute, because
   * the first sample always reports a zero delta and samples arrive ~60s apart.
   *
   * Returns 0 when there are too few readings to judge, so the status-derived
   * figure stands rather than being overridden by a guess.
   */
  private calculateNonChargingHoursFromMeterValues(
    session: Session,
    transaction: ITransactionDto,
  ): number {
    const readings = this.getEnergyReadings(transaction);
    if (readings.length === 0) return 0;

    const sessionStartMs = this.toMs(session.start_date_time);
    const sessionEndMs = this.toMs(
      transaction.customData?.unplugTime ??
        transaction.endTime ??
        session.end_date_time,
    );
    if (sessionStartMs == null || sessionEndMs == null) return 0;

    let idleMs = 0;

    // Head: nothing can have been delivered before the first sample.
    idleMs += Math.max(readings[0].timestampMs - sessionStartMs, 0);

    // Body: an interval with no register movement is parking.
    for (let i = 1; i < readings.length; i++) {
      const advanced = this.registerAdvanced(
        readings[i - 1].kwh,
        readings[i].kwh,
      );
      if (!advanced) {
        idleMs += Math.max(
          readings[i].timestampMs - readings[i - 1].timestampMs,
          0,
        );
      }
    }

    // Tail: after the last sample the car is no longer known to be charging.
    idleMs += Math.max(
      sessionEndMs - readings[readings.length - 1].timestampMs,
      0,
    );

    return this.round4(idleMs / 3600000);
  }

  // session.party_id is our own tenant's party (SessionMapper sets it from
  // transaction.tenant.partyId), so the CDR id tracks the tenant rather than a
  // literal. Stays within the OCPI 39-char limit for CDR.id.
  private generateCdrId(session: Session): string {
    return `CDR**${session.party_id}**${session.id.padStart(5, '0')}`;
  }

  private async createCdrLocation(
    location: LocationDTO,
    session: Session,
  ): Promise<CdrLocation> {
    return {
      id: location.id,
      name: location.name,
      address: location.address,
      city: location.city,
      postal_code: location.postal_code,
      country: location.country,
      coordinates: location.coordinates,
      evse_uid: session.evse_uid,
      evse_id: this.getEvseId(session.evse_uid, location),
      connector_id: session.connector_id,
      connector_standard: this.getConnectorStandard(location, session),
      connector_format: this.getConnectorFormat(location, session),
      connector_power_type: this.getConnectorPowerType(location, session),
    };
  }

  private getEvseId(evseUid: string, location: LocationDTO): string {
    return location.evses?.find((evse) => evse.uid === evseUid)?.evse_id ?? '';
  }

  private getConnectorStandard(
    location: LocationDTO,
    session: Session,
  ): string {
    const evseDto = location.evses?.find(
      (evse) => evse.uid === session.evse_uid,
    );
    const connectorDto = evseDto?.connectors.find(
      (connector) => connector.id === session.connector_id,
    );
    return connectorDto?.standard || '';
  }

  private getConnectorFormat(location: LocationDTO, session: Session): string {
    const evseDto = location.evses?.find(
      (evse) => evse.uid === session.evse_uid,
    );
    const connectorDto = evseDto?.connectors.find(
      (connector) => connector.id === session.connector_id,
    );
    return connectorDto?.format || '';
  }

  private getConnectorPowerType(
    location: LocationDTO,
    session: Session,
  ): string {
    const evseDto = location.evses?.find(
      (evse) => evse.uid === session.evse_uid,
    );
    const connectorDto = evseDto?.connectors.find(
      (connector) => connector.id === session.connector_id,
    );
    return connectorDto?.power_type || '';
  }

  private async getSignedData(
    _session: Session,
  ): Promise<SignedData | undefined> {
    // TODO: Implement signed data logic if required
    return undefined;
  }

  /**
   * Sum PARKING_TIME CdrDimension volumes from charging periods.
   * Per OCPI 2.2.1 spec the volume unit for PARKING_TIME is hours.
   */
  private calculateTotalParkingTimeFromPeriods(session: Session): number {
    let totalHours = 0;
    for (const period of session.charging_periods ?? []) {
      for (const dim of period.dimensions) {
        if (dim.type === CdrDimensionType.PARKING_TIME) {
          totalHours += dim.volume;
        }
      }
    }
    return totalHours;
  }

  /**
   * Query StatusNotifications for the EVSE during the session window and sum time spent
   * in idle statuses (SuspendedEVSE, SuspendedEV, Finishing). The window covers the full
   * session: from start_date_time to unplugTime (= session end for command-stop sessions),
   * so all blocked/idle time — mid-session pauses and post-charging waiting — is captured
   * before the session end, not after it.
   *
   * OCPP evseId is taken from the first TransactionEvent's EvseType.id, which holds the
   * raw OCPP integer used in StatusNotification — not the DB FK on the Transaction row.
   */
  private async calculateNonChargingHours(
    session: Session,
    transaction: ITransactionDto | undefined,
    explicitParkingHours: number,
  ): Promise<number> {
    if (explicitParkingHours > 0 || !transaction) {
      return 0;
    }

    const stationId = transaction.stationId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ocppEvseId: number | null | undefined = (
      transaction.transactionEvents?.[0] as any
    )?.EvseType?.id;

    // OCPP 1.6 path: evseId is absent from StatusNotifications; fall back to
    // timeSpentCharging subtraction (totalConnectedTime − chargingTime).
    // Uses unplugTime as session end so post-charging parking is included.
    if (!stationId || ocppEvseId == null) {
      return this.calculateNonChargingHoursFromTimeSpentCharging(
        session,
        transaction,
      );
    }

    const windowStart = session.start_date_time;
    const windowEnd =
      transaction.customData?.unplugTime ??
      transaction.endTime ??
      session.end_date_time;

    if (!windowStart || !windowEnd) {
      return 0;
    }

    try {
      const response = await this.ocpiGraphqlClient.request<
        GetStatusNotificationsInRangeQueryResult,
        GetStatusNotificationsInRangeQueryVariables
      >(GET_STATUS_NOTIFICATIONS_IN_RANGE, {
        stationId,
        evseId: ocppEvseId,
        start: windowStart,
        end: windowEnd,
      });

      return this.sumIdleTimeFromNotifications(
        response.StatusNotifications,
        windowEnd,
      );
    } catch (error) {
      this.logger.warn(
        'Failed to fetch StatusNotifications for idle time calculation, defaulting to 0',
        { error },
      );
      return 0;
    }
  }

  private sumIdleTimeFromNotifications(
    notifications: Array<{
      timestamp?: string | null;
      connectorStatus?: string | null;
    }>,
    windowEnd: string,
  ): number {
    const IDLE_STATUSES = new Set([
      'SuspendedEVSE',
      'SuspendedEV',
      'Finishing',
    ]);
    let idleMs = 0;

    for (let i = 0; i < notifications.length; i++) {
      const status = notifications[i].connectorStatus;
      if (!status || !IDLE_STATUSES.has(status)) continue;

      const idleStartMs = this.toMs(notifications[i].timestamp);
      if (idleStartMs == null) continue;

      const idleEndMs =
        i + 1 < notifications.length
          ? (this.toMs(notifications[i + 1].timestamp) ?? this.toMs(windowEnd))
          : this.toMs(windowEnd);

      if (idleEndMs == null) continue;
      idleMs += Math.max(idleEndMs - idleStartMs, 0);
    }

    return this.round4(idleMs / 3600000);
  }

  private calculateNonChargingHoursFromTimeSpentCharging(
    session: Session,
    transaction: ITransactionDto,
  ): number {
    if (transaction.timeSpentCharging == null) return 0;
    const sessionStartMs = this.toMs(session.start_date_time);
    const sessionEndMs = this.toMs(
      transaction.customData?.unplugTime ??
        transaction.endTime ??
        session.end_date_time,
    );
    const chargingSeconds = Number(transaction.timeSpentCharging);
    if (
      sessionStartMs == null ||
      sessionEndMs == null ||
      !Number.isFinite(chargingSeconds)
    )
      return 0;
    const totalConnectedHours =
      Math.max(sessionEndMs - sessionStartMs, 0) / 3600000;
    const chargingHours = Math.max(chargingSeconds, 0) / 3600;
    return this.round4(Math.max(totalConnectedHours - chargingHours, 0));
  }

  private toMs(value: string | null | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }

  /**
   * OCPI total_time: "Total duration of the charging session (including the
   * duration of charging and not charging), in hours."
   *
   * Deliberately the full wall clock. It is a reported measurement, not a
   * billable quantity — the eMSP derives total_charging_time from
   * total_time - total_parking_time, so trimming this would corrupt their view
   * of the session. Warm-up and stalls are excluded from the bill via
   * total_parking_time instead.
   */
  private calculateTotalTime(session: Session): number {
    if (!session.end_date_time) return 0;

    const elapsedMs =
      new Date(session.end_date_time).getTime() -
      new Date(session.start_date_time).getTime();

    return elapsedMs > 0 ? elapsedMs / 3600000 : 0;
  }

  private generateRemark(_session: Session): string | undefined {
    // TODO: Generate remark based on session details if needed
    return undefined;
  }

  private async generateInvoiceReferenceId(
    _session: Session,
  ): Promise<string | undefined> {
    // TODO: Generate invoice reference ID if needed
    return undefined;
  }

  private isCredit(
    _session: Session,
    _tariff: ITariffDto,
  ): boolean | undefined {
    // TODO: Return whether CDR is a Credit CDR if needed
    return undefined;
  }

  private generateCreditReferenceId(
    _session: Session,
    _tariff: ITariffDto,
  ): string | undefined {
    // TODO: Return Credit Reference ID for Credit CDR if needed
    return undefined;
  }

  private getCompletedTransactions(
    transactions: ITransactionDto[],
  ): ITransactionDto[] {
    return transactions.filter((transaction) => !transaction.isActive);
  }
}
