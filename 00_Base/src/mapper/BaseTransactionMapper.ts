// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  IAuthorizationDto,
  IMeterValueDto,
  ITariffDto,
  OCPP2_0_1,
} from '@citrineos/base';
import { TokenDTO } from '../model/DTO/TokenDTO';
import { ILogObj, Logger } from 'tslog';
import { Price } from '../model/Price';
import { Session } from '../model/Session';
import { Tariff as OcpiTariff } from '../model/Tariff';
import { TariffDTO } from '../model/DTO/tariffs/TariffDTO';
import { LocationDTO } from '../model/DTO/LocationDTO';
import { LocationsService } from '../services/LocationsService';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { GET_LOCATION_BY_ID_QUERY } from '../graphql/queries/location.queries';
// import { GET_TARIFF_BY_CORE_KEY_QUERY } from '../graphql/queries/tariff.queries';
import { ITransactionDto, ILocationDto } from '@citrineos/base';
import { LocationMapper } from './LocationMapper';
import { TokensMapper } from './TokensMapper';
import {
  GetAuthorizationByIdQueryResult,
  GetAuthorizationByIdQueryVariables,
  GetLocationByIdQueryResult,
  GetLocationByIdQueryVariables,
  GetTariffByKeyQueryResult,
  GetTariffByKeyQueryVariables,
  GetTransactionByTransactionIdQueryResult,
  GetTransactionByTransactionIdQueryVariables,
} from '../graphql/operations';
import { GET_TARIFF_BY_KEY_QUERY } from '../graphql/queries/tariff.queries';
import { GET_TRANSACTION_BY_ID_QUERY } from '../graphql/queries/transaction.queries';
import { TariffMapper } from './TariffMapper';
import { GET_AUTHORIZATION_BY_ID } from '../graphql';
import { getBillingEnergyThresholdKwh, MINUTES_IN_HOUR } from '../util/Consts';

export abstract class BaseTransactionMapper {
  protected constructor(
    protected logger: Logger<ILogObj>,
    protected locationsService: LocationsService,
    protected ocpiGraphqlClient: OcpiGraphqlClient,
  ) {}

  public async getLocationDTOsForTransactions(
    transactions: ITransactionDto[],
  ): Promise<Map<string, LocationDTO>> {
    const transactionIdToLocationMap: Map<string, LocationDTO> = new Map();
    for (const transaction of transactions) {
      if (!transaction.location && transaction.locationId) {
        const result = await this.ocpiGraphqlClient.request<
          GetLocationByIdQueryResult,
          GetLocationByIdQueryVariables
        >(GET_LOCATION_BY_ID_QUERY, { id: transaction.locationId });
        transaction.location = result.Locations[0] as ILocationDto;
      }
      const location = transaction.location;
      if (!location) {
        this.logger.debug(
          `Skipping transaction ${transaction.id} location ${transaction.locationId}`,
        );
        continue;
      }

      const locationDto = LocationMapper.fromGraphql(location);

      transactionIdToLocationMap.set(transaction.id!.toString(), locationDto);
    }
    return transactionIdToLocationMap;
  }

  protected async getTokensForTransactions(
    transactions: ITransactionDto[],
  ): Promise<Map<string, TokenDTO>> {
    const transactionIdToTokenMap: Map<string, TokenDTO> = new Map();

    for (const transaction of transactions) {
      // if (!transaction.authorization && transaction.authorizationId) {
      if (transaction.authorizationId) {
        const result = await this.ocpiGraphqlClient.request<
          GetAuthorizationByIdQueryResult,
          GetAuthorizationByIdQueryVariables
        >(GET_AUTHORIZATION_BY_ID, { id: transaction.authorizationId });
        if (result.Authorizations_by_pk) {
          transaction.authorization =
            result.Authorizations_by_pk as IAuthorizationDto;
        }
      }
      if (transaction.authorization) {
        const tokenDto = TokensMapper.toDto(transaction.authorization);
        if (tokenDto) {
          transactionIdToTokenMap.set(transaction.id!.toString(), tokenDto);
        } else {
          this.logger.debug(`Unmapped token for transaction ${transaction.id}`);
        }
      } else {
        this.logger.debug(`No token for transaction ${transaction.id}`);
      }
    }

    return transactionIdToTokenMap;
  }

  protected async getTariffsForTransactions(
    transactions: ITransactionDto[],
  ): Promise<Map<string, ITariffDto>> {
    const transactionIdToTariffMap = new Map<string, ITariffDto>();
    for (const transaction of transactions) {
      // If tariffId is missing (e.g. partial transaction), fetch it from the DB
      if (!transaction.tariff && !transaction.tariffId && transaction.id) {
        const txResult = await this.ocpiGraphqlClient.request<
          GetTransactionByTransactionIdQueryResult,
          GetTransactionByTransactionIdQueryVariables
        >(GET_TRANSACTION_BY_ID_QUERY, { id: transaction.id });
        if (txResult.Transactions[0]?.tariffId) {
          transaction.tariffId = txResult.Transactions[0].tariffId;
        }
      }
      if (!transaction.tariff && transaction.tariffId) {
        const result = await this.ocpiGraphqlClient.request<
          GetTariffByKeyQueryResult,
          GetTariffByKeyQueryVariables
        >(GET_TARIFF_BY_KEY_QUERY, {
          id: transaction.tariffId,
          countryCode: transaction.tenant!.countryCode!,
          partyId: transaction.tenant!.partyId!,
        });
        if (result.Tariffs[0]) {
          transaction.tariff = result.Tariffs[0] as ITariffDto;
        }
      }
      const tariff = transaction.tariff;
      if (tariff) {
        transactionIdToTariffMap.set(transaction.id!.toString(), tariff);
      } else {
        this.logger.debug(`No tariff for ${transaction.id}`);
      }
    }
    return transactionIdToTariffMap;
  }

  protected async getOcpiTariffsForTransactions(
    sessions: Session[],
    transactionIdToTariffMap: Map<string, ITariffDto>,
  ): Promise<Map<string, OcpiTariff>> {
    const transactionIdToOcpiTariffMap = new Map<string, OcpiTariff>();
    await Promise.all(
      sessions
        .filter((session) => transactionIdToTariffMap.get(session.id))
        .map(async (session) => {
          const tariffVariables = {
            id: transactionIdToTariffMap.get(session.id)!.id!,
            // TODO: Ensure CPO Country Code, Party ID exists for the tariff in question
            countryCode: session.country_code,
            partyId: session.party_id,
          };
          const result = await this.ocpiGraphqlClient.request<
            GetTariffByKeyQueryResult,
            GetTariffByKeyQueryVariables
          >(GET_TARIFF_BY_KEY_QUERY, tariffVariables);
          const tariff = result.Tariffs[0] as ITariffDto;
          if (tariff) {
            transactionIdToOcpiTariffMap.set(
              session.id,
              TariffMapper.map(tariff),
            );
          }
        }),
    );
    return transactionIdToOcpiTariffMap;
  }

  protected calculateTotalCost(totalKwh: number, tariffCost: number): Price {
    return {
      excl_vat: Math.floor(totalKwh * tariffCost * 100) / 100,
    };
  }

  /**
   * A session's energy register readings, in kWh, sorted oldest first.
   *
   * The register is the only witness to whether energy actually moved. Charger
   * status is self-reported and can be wrong in the case that matters most:
   * EVSE fe50ec85 reported Charging across three sessions while transferring
   * 0.000 kWh.
   */
  protected getEnergyReadings(
    transaction: ITransactionDto,
  ): Array<{ timestampMs: number; kwh: number }> {
    const readings: Array<{ timestampMs: number; kwh: number }> = [];

    for (const meterValue of transaction.meterValues ?? []) {
      const kwh = this.getEnergyRegisterKwh(meterValue);
      if (kwh == null || meterValue.timestamp == null) continue;
      const timestampMs = new Date(meterValue.timestamp).getTime();
      if (Number.isNaN(timestampMs)) continue;
      readings.push({ timestampMs, kwh });
    }

    return readings.sort((a, b) => a.timestampMs - b.timestampMs);
  }

  /**
   * Whether a session ever delivered enough energy to count as charging at all.
   *
   * Registers are cumulative and large, so subtracting two of them loses
   * precision — 358.09 - 358.07 yields 0.019999999999527, which would fail an
   * exact >= 0.02. Round the delta to well below one 10 Wh register step first.
   */
  protected hasEnergyConfirmation(transaction: ITransactionDto): boolean {
    const threshold = getBillingEnergyThresholdKwh();
    if (!threshold) return true;

    const readings = this.getEnergyReadings(transaction);
    if (readings.length === 0) return false;

    const baseline = Math.min(...readings.map((reading) => reading.kwh));
    const peak = Math.max(...readings.map((reading) => reading.kwh));

    return this.round6(peak - baseline) >= threshold;
  }

  /**
   * Cumulative Energy.Active.Import.Register for a meter value, in kWh.
   * Phase-specific samples are skipped — only the aggregate is meaningful here.
   */
  protected getEnergyRegisterKwh(
    meterValue?: IMeterValueDto,
  ): number | undefined {
    // `measurand` is optional in both OCPP 1.6 and 2.0.1 and defaults to
    // Energy.Active.Import.Register when omitted. Requiring it to be present
    // meant a charger that relies on the default produced no readings at all —
    // and every consumer of an empty reading set fails OPEN: parking time falls
    // back to self-reported status, which is the very source this branch exists
    // because it lies, and the full wall clock gets priced.
    const sample = meterValue?.sampledValue?.find(
      (sampledValue) =>
        (sampledValue.measurand ===
          OCPP2_0_1.MeasurandEnumType.Energy_Active_Import_Register ||
          sampledValue.measurand == null) &&
        !sampledValue.phase,
    );
    if (sample?.value == null) return undefined;

    const value = Number(sample.value);
    if (!Number.isFinite(value)) return undefined;

    // OCPP 1.6 reports the unit in a flat `unit` field, 2.0.1 nests it under
    // unitOfMeasure. Production only ever sends the flat form, and two stations
    // report kWh rather than Wh, so both shapes and both casings must be read —
    // getting this wrong understates a session by 1000x and it silently never
    // reaches the energy threshold.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (sample as any).unit ?? (sample as any).unitOfMeasure?.unit;
    const unit = typeof raw === 'string' ? raw.toUpperCase() : undefined;
    return unit === 'KWH' ? value : value / 1000; // OCPP default unit is Wh
  }

  /**
   * Fixed per-session cost (OCPI FLAT tariff dimension).
   * Returns undefined when the tariff has no session fee.
   */
  protected computeFixedCost(tariff: ITariffDto): Price | undefined {
    if (!tariff.pricePerSession) return undefined;
    const excl_vat = this.round4(tariff.pricePerSession);
    return this.buildPrice(excl_vat, tariff.taxRate);
  }

  /**
   * Energy cost: kWh consumed × pricePerKwh (OCPI ENERGY tariff dimension).
   * Returns undefined when the tariff has no energy rate.
   */
  protected computeEnergyCost(
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
  protected computeTimeCost(
    totalTimeHours: number,
    tariff: ITariffDto,
  ): Price | undefined {
    if (!tariff.pricePerMin) return undefined;
    const pricePerHour = tariff.pricePerMin * MINUTES_IN_HOUR;
    const excl_vat = this.round4(totalTimeHours * pricePerHour);
    return this.buildPrice(excl_vat, tariff.taxRate);
  }

  protected sumCosts(costs: (Price | undefined)[], tariff: ITariffDto): Price {
    const excl_vat = costs.reduce(
      (acc, cost) => acc + (cost?.excl_vat ?? 0),
      0,
    );
    return this.buildPrice(this.round4(excl_vat), tariff.taxRate);
  }

  /**
   * Build a Price with optional incl_vat derived from taxRate.
   */
  protected buildPrice(excl_vat: number, taxRate?: number | null): Price {
    if (taxRate) {
      return {
        excl_vat,
        incl_vat: this.round4(excl_vat * (1 + taxRate)),
      };
    }
    return { excl_vat };
  }

  protected round4(value: number): number {
    return Math.round(value * 10000) / 10000;
  }

  protected round6(value: number): number {
    return Math.round(value * 1000000) / 1000000;
  }

  /**
   * Whether the energy register actually moved between two readings.
   *
   * This one predicate decides where charging stopped, how much parking is
   * billable, and the live elapsed hours — so it has to answer the same way in
   * all three places. Registers are cumulative and large, and the values arrive
   * divided by 1000, so a bare `>` counts float noise as delivered energy:
   * charging time inflates in one direction while billable idle shrinks in the
   * other. Compare at the same precision hasEnergyConfirmation uses, well below
   * one 10 Wh register step.
   */
  protected registerAdvanced(previousKwh: number, nextKwh: number): boolean {
    return this.round6(nextKwh - previousKwh) > 0;
  }
}
