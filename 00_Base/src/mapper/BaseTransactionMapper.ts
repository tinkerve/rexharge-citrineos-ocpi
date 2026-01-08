// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { IAuthorizationDto, ITariffDto } from '@citrineos/base';
import { TokenDTO } from '../model/DTO/TokenDTO';
import { ILogObj, Logger } from 'tslog';
import { Price } from '../model/Price';
import { Session } from '../model/Session';
import { Tariff as OcpiTariff } from '../model/Tariff';
import { LocationDTO } from '../model/DTO/LocationDTO';
import { LocationsService } from '../services/LocationsService';
import { ExternalDatabaseService } from '../services/ExternalDatabaseService';
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
  GetStatusNotificationsInRangeQueryVariables,
  GetTariffByKeyQueryResult,
  GetTariffByKeyQueryVariables,
} from '../graphql/operations';
import { GET_TARIFF_BY_KEY_QUERY } from '../graphql/queries/tariff.queries';
import { TariffMapper } from './TariffMapper';
import { GET_AUTHORIZATION_BY_ID } from '../graphql';
import { GET_STATUS_NOTIFICATIONS_IN_RANGE } from '../graphql/queries';

export abstract class BaseTransactionMapper {
  protected constructor(
    protected logger: Logger<ILogObj>,
    protected locationsService: LocationsService,
    protected ocpiGraphqlClient: OcpiGraphqlClient,
    protected externalDatabaseService: ExternalDatabaseService,
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

      transactionIdToLocationMap.set(transaction.transactionId!, locationDto);
    }
    return transactionIdToLocationMap;
  }

  protected async getTokensForTransactions(
    transactions: ITransactionDto[],
  ): Promise<Map<string, TokenDTO>> {
    const transactionIdToTokenMap: Map<string, TokenDTO> = new Map();

    for (const transaction of transactions) {
      if (!transaction.authorization && transaction.authorizationId) {
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
        const tokenDto = await TokensMapper.toDto(transaction.authorization);
        if (tokenDto) {
          transactionIdToTokenMap.set(transaction.transactionId!, tokenDto);
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
        transactionIdToTariffMap.set(transaction.transactionId!, tariff);
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
   * Calculates the total cost for a transaction by querying the external database
   * Gets the rate from citrine_extended_location table based on location_id
   * @param transaction - The transaction DTO containing all transaction data
   * @returns Object with excl_vat property containing the calculated cost
   */
  protected async calculateTotalCostFromDatabase(
    transaction: Partial<ITransactionDto>,
    tariff: ITariffDto,
  ): Promise<Price> {
    try {
      const transactionId = transaction.transactionId;
      const locationId = transaction.locationId;
      const totalKwh = transaction.totalKwh ?? 0;

      if (!locationId) {
        this.logger.warn(
          `No location_id found for transaction ${transactionId ?? 'unknown'}`,
        );
        return { excl_vat: 0 };
      }

      // Calculate total time in hours
      const totalTimeHours =
        transaction.endTime && transaction.startTime
          ? (new Date(transaction.endTime).getTime() -
              new Date(transaction.startTime).getTime()) /
            (1000 * 60 * 60)
          : 0;

      // Query the citrine_extended_location table to get the rate and charge method
      const result = await this.externalDatabaseService.query<{
        privilege_rate: number;
        charge_method: string;
        idle_rate: number;
      }>(
        `SELECT privilege_rate, charge_method, idle_rate 
         FROM citrine_extended_location 
         WHERE citrine_location_id = $1 AND deleted_at IS NULL`,
        [locationId],
      );

      if (result.rows.length === 0) {
        this.logger.warn(
          `No extended location found for location_id ${locationId}, transaction ${transactionId}`,
        );
        return { excl_vat: 0 };
      }

      const { charge_method, idle_rate } = result.rows[0];

      const ratePerKwh = tariff?.pricePerKwh ?? 0;
      const ratePerMinute = tariff?.pricePerMin ?? 0;
      const rateFlat = tariff?.pricePerSession ?? 0;

      let baseCost = 0;

      // Calculate base cost based on charge method
      switch (charge_method) {
        case 'PER_KWH':
          baseCost = totalKwh * ratePerKwh;
          break;
        case 'PER_MINUTE':
          baseCost = totalTimeHours * 60 * ratePerMinute; // Convert hours to minutes
          break;
        case 'FLAT_RATE':
          baseCost = rateFlat;
          break;
        case 'FREE':
          baseCost = 0;
          break;
        default:
          this.logger.warn(
            `Unknown charge method ${charge_method} for location ${locationId}`,
          );
          baseCost = 0;
      }

      // Calculate idle cost using connector status notifications within the session window
      let idleCost = 0;
      if (idle_rate && transaction.startTime && transaction.endTime) {
        const idleDurationHours = await this.getIdleDurationHours(
          transaction,
          new Date(transaction.startTime),
          new Date(transaction.endTime),
        );
        // Assume idle_rate is per minute (matches PER_MINUTE usage pattern)
        idleCost = idleDurationHours * 60 * idle_rate;
        this.logger.debug(
          `Idle calculation for tx ${transactionId ?? 'unknown'} | idle_rate ${idle_rate} | idle_hours ${idleDurationHours} | idle_cost ${idleCost}`,
        );
      }

      const totalCost = baseCost + idleCost;

      this.logger.debug(
        `Calculated cost for tx ${transactionId ?? 'unknown'} | base_cost ${baseCost} | idle_cost ${idleCost} | total_cost ${totalCost} | method ${charge_method} | rates (kWh ${ratePerKwh}, min ${ratePerMinute}, flat ${rateFlat}) | idle_rate ${idle_rate} | kWh ${totalKwh} | hours ${totalTimeHours}`,
      );

      return {
        excl_vat: Math.floor(totalCost * 100) / 100, // Round to 2 decimal places
      };
    } catch (error) {
      this.logger.error(
        `Failed to calculate total cost for transaction ${transaction.transactionId ?? 'unknown'}`,
        error,
      );
      // Return 0 cost on error to prevent mapping failures
      return { excl_vat: 0 };
    }
  }

  private async getIdleDurationHours(
    transaction: Partial<ITransactionDto>,
    sessionStart: Date,
    sessionEnd: Date,
  ): Promise<number> {
    if (
      !transaction.stationId ||
      !transaction.evseId ||
      !transaction.connectorId ||
      !transaction.tenantId
    ) {
      this.logger.debug(
        `Skipping idle calculation for tx ${transaction.transactionId ?? 'unknown'} due to missing station/evse/connector/tenant info`,
      );
      return 0;
    }

    const variables: GetStatusNotificationsInRangeQueryVariables = {
      stationId: transaction.stationId,
      connectorId: transaction.connectorId,
      tenantId: transaction.tenantId,
      start: sessionStart.toISOString(),
      end: sessionEnd.toISOString(),
    };

    type StatusNotificationRecord = {
      timestamp: string;
      connectorStatus: string;
    };
    type GetStatusNotificationsInRangeResult = {
      StatusNotifications: StatusNotificationRecord[];
    };

    const response = await this.ocpiGraphqlClient.request<
      GetStatusNotificationsInRangeResult,
      GetStatusNotificationsInRangeQueryVariables
    >(GET_STATUS_NOTIFICATIONS_IN_RANGE, variables);

    const notifications = (response?.StatusNotifications || []).sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    this.logger.debug(
      `Fetched ${notifications.length} status notifications for tx ${transaction.transactionId ?? 'unknown'} between ${sessionStart.toISOString()} and ${sessionEnd.toISOString()}`,
    );

    if (!notifications.length) {
      this.logger.debug(
        `No status notifications found for tx ${transaction.transactionId ?? 'unknown'}, returning 0 idle hours`,
      );
      return 0;
    }

    const idleStatuses = new Set(['SuspendedEVSE', 'SuspendedEV', 'Preparing']);
    const windowStart = sessionStart.getTime();
    const windowEnd = sessionEnd.getTime();

    let idleMs = 0;
    let lastTs = windowStart;
    let lastStatus = ''; // assume not idle until first record

    this.logger.debug(
      `Processing idle periods for tx ${transaction.transactionId ?? 'unknown'} | idle statuses: ${Array.from(idleStatuses).join(', ')}`,
    );

    for (const notification of notifications) {
      const ts = new Date(notification.timestamp).getTime();

      if (ts < windowStart) {
        lastTs = windowStart;
        lastStatus = notification.connectorStatus;
        continue;
      }
      if (ts > windowEnd) {
        break;
      }

      if (idleStatuses.has(lastStatus)) {
        const periodMs = ts - lastTs;
        idleMs += periodMs;
        this.logger.debug(
          `Idle period detected | status ${lastStatus} | from ${new Date(lastTs).toISOString()} to ${new Date(ts).toISOString()} | duration ${(periodMs / 1000 / 60).toFixed(2)} min`,
        );
      }

      lastTs = ts;
      lastStatus = notification.connectorStatus;
    }

    if (idleStatuses.has(lastStatus)) {
      const finalMs = windowEnd - lastTs;
      idleMs += finalMs;
      this.logger.debug(
        `Final idle period | status ${lastStatus} | from ${new Date(lastTs).toISOString()} to ${new Date(windowEnd).toISOString()} | duration ${(finalMs / 1000 / 60).toFixed(2)} min`,
      );
    }

    const totalIdleHours = idleMs / (1000 * 60 * 60);
    this.logger.debug(
      `Total idle duration for tx ${transaction.transactionId ?? 'unknown'} | ${(idleMs / 1000 / 60).toFixed(2)} min | ${totalIdleHours.toFixed(4)} hours`,
    );

    return totalIdleHours;
  }
}
