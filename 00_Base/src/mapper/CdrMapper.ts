// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITariffDto, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { Service } from 'typedi';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { Cdr } from '../model/Cdr';
import { CdrDimensionType } from '../model/CdrDimensionType';
import { CdrLocation } from '../model/CdrLocation';
import { LocationDTO } from '../model/DTO/LocationDTO';
import { Price } from '../model/Price';
import { Session } from '../model/Session';
import { SignedData } from '../model/SignedData';
import { Tariff as OcpiTariff } from '../model/Tariff';
import { LocationsService } from '../services/LocationsService';
import { MINUTES_IN_HOUR } from '../util/Consts';
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
            transactionIdToLocationMap.get(session.id)!,
            transactionIdToTariffMap.get(session.id)!,
            transactionIdToOcpiTariffMap.get(session.id)!,
          ),
        ),
    );
  }

  private async mapSessionToCDR(
    session: Session,
    location: LocationDTO,
    tariff: ITariffDto,
    ocpiTariff: OcpiTariff,
  ): Promise<Cdr> {
    const totalEnergy = session.kwh;
    const totalTime = this.calculateTotalTime(session);
    const totalParkingTime = this.calculateTotalParkingTimeFromPeriods(session);

    const totalEnergyCost = this.computeEnergyCost(totalEnergy, tariff);
    const totalTimeCost = this.computeTimeCost(totalTime, tariff);
    const totalFixedCost = this.computeFixedCost(tariff);

    const totalCost = this.sumCosts(
      [totalEnergyCost, totalTimeCost, totalFixedCost],
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
      total_parking_cost: undefined,
      total_reservation_cost: undefined,
      remark: this.generateRemark(session),
      invoice_reference_id: await this.generateInvoiceReferenceId(session),
      credit: this.isCredit(session, tariff),
      credit_reference_id: this.generateCreditReferenceId(session, tariff),
      last_updated: toISOStringIfNeeded(session.last_updated, true),
    };
  }

  private generateCdrId(session: Session): string {
    return `CDR**REX**${session.id.padStart(5, '0')}`;
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
   * Flat session fee (OCPI FLAT tariff dimension).
   * Returns undefined if no per-session fee is configured on the tariff.
   */
  private computeFixedCost(tariff: ITariffDto): Price | undefined {
    if (!tariff.pricePerSession) return undefined;
    const excl_vat = this.round4(tariff.pricePerSession);
    return this.buildPrice(excl_vat, tariff.taxRate);
  }

  /**
   * Energy cost: kWh consumed × pricePerKwh (OCPI ENERGY tariff dimension).
   * Returns undefined when the tariff has no energy rate.
   */
  private computeEnergyCost(
    totalKwh: number,
    tariff: ITariffDto,
  ): Price | undefined {
    if (!tariff.pricePerKwh) return undefined;
    const excl_vat = this.round4(totalKwh * tariff.pricePerKwh);
    return this.buildPrice(excl_vat, tariff.taxRate);
  }

  /**
   * Time cost: session duration in hours × pricePerMin × 60 (OCPI TIME dimension).
   * TariffMapper stores the TIME price component as pricePerMin*60 (per-hour rate),
   * so we multiply total_time (hours) by that same per-hour rate here.
   * Returns undefined when the tariff has no time rate.
   */
  private computeTimeCost(
    totalTimeHours: number,
    tariff: ITariffDto,
  ): Price | undefined {
    if (!tariff.pricePerMin) return undefined;
    const pricePerHour = tariff.pricePerMin * MINUTES_IN_HOUR;
    const excl_vat = this.round4(totalTimeHours * pricePerHour);
    return this.buildPrice(excl_vat, tariff.taxRate);
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
   * Grand total cost = sum of all non-null cost components.
   * Includes incl_vat when a taxRate is present on the tariff.
   */
  private sumCosts(costs: (Price | undefined)[], tariff: ITariffDto): Price {
    const excl_vat = costs.reduce(
      (acc, cost) => acc + (cost?.excl_vat ?? 0),
      0,
    );
    return this.buildPrice(this.round4(excl_vat), tariff.taxRate);
  }

  /**
   * Build a Price with optional incl_vat derived from taxRate.
   */
  private buildPrice(excl_vat: number, taxRate?: number | null): Price {
    if (taxRate) {
      return {
        excl_vat,
        incl_vat: this.round4(excl_vat * (1 + taxRate)),
      };
    }
    return { excl_vat };
  }

  private round4(value: number): number {
    return Math.round(value * 10000) / 10000;
  }

  private calculateTotalTime(session: Session): number {
    if (session.end_date_time) {
      return (
        (new Date(session.end_date_time).getTime() -
          new Date(session.start_date_time).getTime()) /
        3600000
      ); // Convert ms to hours
    }
    return 0;
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
