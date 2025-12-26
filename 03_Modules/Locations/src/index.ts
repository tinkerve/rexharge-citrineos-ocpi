// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  AbstractDtoModule,
  AsDtoEventHandler,
  DtoEventObjectType,
  DtoEventType,
  EvseMapper,
  GET_CHARGING_STATION_BY_ID_QUERY,
  GetChargingStationByIdQueryResult,
  GetChargingStationByIdQueryVariables,
  IDtoEvent,
  LocationsBroadcaster,
  OcpiConfig,
  OcpiConfigToken,
  OcpiGraphqlClient,
  OcpiModule,
  RabbitMqDtoReceiver,
} from '@citrineos/ocpi-base';
import { ILogObj, Logger } from 'tslog';
import { LocationsModuleApi } from './module/LocationsModuleApi';
import {
  IChargingStationDto,
  IConnectorDto,
  IEvseDto,
  ILocationDto,
} from '@citrineos/base';
import { Inject, Service } from 'typedi';
import { EvseStatus } from '@citrineos/ocpi-base/src/model/EvseStatus';

export { LocationsModuleApi } from './module/LocationsModuleApi';
export { ILocationsModuleApi } from './module/ILocationsModuleApi';

@Service()
export class LocationsModule extends AbstractDtoModule implements OcpiModule {
  constructor(
    @Inject(OcpiConfigToken) config: OcpiConfig,
    readonly logger: Logger<ILogObj>,
    readonly locationsBroadcaster: LocationsBroadcaster,
    readonly ocpiGraphqlClient: OcpiGraphqlClient,
  ) {
    super(config, new RabbitMqDtoReceiver(config, logger), logger);
  }

  getController(): any {
    return LocationsModuleApi;
  }

  async init(): Promise<void> {
    this._logger.info('Initializing Locations Module...');
    await this._receiver.init();
    this._logger.info('Locations Module initialized successfully.');
  }

  async shutdown(): Promise<void> {
    this._logger.info('Shutting down Locations Module...');
    await super.shutdown();
  }

  @AsDtoEventHandler(
    DtoEventType.INSERT,
    DtoEventObjectType.Location,
    'LocationNotification',
  )
  async handleLocationInsert(event: IDtoEvent<ILocationDto>): Promise<void> {
    this._logger.debug(`Handling Location Insert: ${JSON.stringify(event)}`);
    const locationDto = event._payload;
    const tenant = locationDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${locationDto.id}, cannot broadcast.`,
      );
      return;
    }

    await this.locationsBroadcaster.broadcastPutLocation(tenant, locationDto);
  }

  @AsDtoEventHandler(
    DtoEventType.UPDATE,
    DtoEventObjectType.Location,
    'LocationNotification',
  )
  async handleLocationUpdate(
    event: IDtoEvent<Partial<ILocationDto>>,
  ): Promise<void> {
    this._logger.debug(`Handling Location Update: ${JSON.stringify(event)}`);
    const locationDto = event._payload;
    const tenant = locationDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${locationDto.id}, cannot broadcast.`,
      );
      return;
    }

    await this.locationsBroadcaster.broadcastPatchLocation(tenant, locationDto);
  }

  @AsDtoEventHandler(
    DtoEventType.UPDATE,
    DtoEventObjectType.ChargingStation,
    'ChargingStationNotification',
  )
  async handleChargingStationUpdate(
    event: IDtoEvent<Partial<IChargingStationDto>>,
  ): Promise<void> {
    this._logger.debug(
      `Handling Charging Station Update: ${JSON.stringify(event)}`,
    );
    // Updates are Location/Evse PATCH requests
    // await this.locationsBroadcaster.broadcastPatchEvse(event._payload); // todo
  }

  @AsDtoEventHandler(
    DtoEventType.INSERT,
    DtoEventObjectType.Evse,
    'EvseNotification',
  )
  async handleEvseInsert(event: IDtoEvent<IEvseDto>): Promise<void> {
    this._logger.debug(`Handling EVSE Insert: ${JSON.stringify(event)}`);
    const evseDto = event._payload;
    const tenant = evseDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${evseDto.id}, cannot broadcast.`,
      );
      return;
    }

    const chargingStationResponse = await this.ocpiGraphqlClient.request<
      GetChargingStationByIdQueryResult,
      GetChargingStationByIdQueryVariables
    >(GET_CHARGING_STATION_BY_ID_QUERY, { id: evseDto.stationId });
    if (!chargingStationResponse.ChargingStations[0]) {
      this._logger.error(
        `Charging Station not found for ID ${evseDto.stationId}, cannot broadcast.`,
      );
      return;
    }
    evseDto.chargingStation = chargingStationResponse
      .ChargingStations[0] as IChargingStationDto;

    await this.locationsBroadcaster.broadcastPutEvse(tenant, evseDto);
  }

  @AsDtoEventHandler(
    DtoEventType.UPDATE,
    DtoEventObjectType.Evse,
    'EvseNotification',
  )
  async handleEvseUpdate(event: IDtoEvent<Partial<IEvseDto>>): Promise<void> {
    this._logger.debug(`Handling EVSE Update: ${JSON.stringify(event)}`);
    const evseDto = event._payload;
    const tenant = evseDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${evseDto.id}, cannot broadcast.`,
      );
      return;
    }

    const chargingStationResponse = await this.ocpiGraphqlClient.request<
      GetChargingStationByIdQueryResult,
      GetChargingStationByIdQueryVariables
    >(GET_CHARGING_STATION_BY_ID_QUERY, { id: evseDto.stationId! });
    if (!chargingStationResponse.ChargingStations[0]) {
      this._logger.error(
        `Charging Station not found for ID ${evseDto.stationId}, cannot broadcast.`,
      );
      return;
    }
    evseDto.chargingStation = chargingStationResponse
      .ChargingStations[0] as IChargingStationDto;

    await this.locationsBroadcaster.broadcastPatchEvse(tenant, evseDto);
  }

  @AsDtoEventHandler(
    DtoEventType.INSERT,
    DtoEventObjectType.Connector,
    'ConnectorNotification',
  )
  async handleConnectorInsert(event: IDtoEvent<IConnectorDto>): Promise<void> {
    this._logger.debug(`Handling Connector Insert: ${JSON.stringify(event)}`);
    const connectorDto = event._payload;
    const tenant = connectorDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${connectorDto.id}, cannot broadcast.`,
      );
      return;
    }

    const chargingStationResponse = await this.ocpiGraphqlClient.request<
      GetChargingStationByIdQueryResult,
      GetChargingStationByIdQueryVariables
    >(GET_CHARGING_STATION_BY_ID_QUERY, { id: connectorDto.stationId });
    if (!chargingStationResponse.ChargingStations[0]) {
      this._logger.error(
        `Charging Station not found for ID ${connectorDto.stationId}, cannot broadcast.`,
      );
      return;
    }
    connectorDto.chargingStation = chargingStationResponse
      .ChargingStations[0] as IChargingStationDto;

    await this.locationsBroadcaster.broadcastPutConnector(tenant, connectorDto);
  }

  @AsDtoEventHandler(
    DtoEventType.UPDATE,
    DtoEventObjectType.Connector,
    'ConnectorNotification',
  )
  async handleConnectorUpdate(
    event: IDtoEvent<Partial<IConnectorDto>>,
  ): Promise<void> {
    this._logger.debug(`Handling Connector Update: ${JSON.stringify(event)}`);
    const connectorDto = event._payload;
    const tenant = connectorDto.tenant;
    if (!tenant) {
      this._logger.error(
        `Tenant data missing in ${event._context.eventType} notification for ${event._context.objectType} ${connectorDto.id}, cannot broadcast.`,
      );
      return;
    }

    const chargingStationResponse = await this.ocpiGraphqlClient.request<
      GetChargingStationByIdQueryResult,
      GetChargingStationByIdQueryVariables
    >(GET_CHARGING_STATION_BY_ID_QUERY, { id: connectorDto.stationId! });
    if (!chargingStationResponse.ChargingStations[0]) {
      this._logger.error(
        `Charging Station not found for ID ${connectorDto.stationId}, cannot broadcast.`,
      );
      return;
    }
    connectorDto.chargingStation = chargingStationResponse
      .ChargingStations[0] as IChargingStationDto;

    // Check if this is a status update
    const isStatusUpdate = this.isStatusOnlyUpdate(connectorDto);

    if (isStatusUpdate) {
      // Status updates should be broadcasted at EVSE level with aggregated status
      this._logger.debug(
        `Broadcasting connector status update at EVSE level for connector ${connectorDto.id}`,
      );

      const connectorData = connectorDto.chargingStation.connectors?.filter(
        (connector) =>
          connector.evseId === connectorDto.evseId &&
          connector.stationId === connectorDto.stationId,
      );

      if (!connectorData || connectorData.length === 0) {
        this._logger.error(
          `Connector data not found for Connector ID ${connectorDto.id}, cannot aggregate status.`,
        );
        return;
      }

      // Aggregate the status from all connectors
      const aggregatedStatus =
        EvseMapper.mapEvseStatusFromConnectors(connectorData);

      // Broadcast EVSE patch with aggregated status
      const evseDto: Partial<IEvseDto> = {
        id: connectorDto.evseId,
        stationId: connectorDto.stationId,
        chargingStation: connectorDto.chargingStation,
        tenant: tenant,
        updatedAt: connectorDto.updatedAt,
      };

      this._logger.debug(
        `Aggregated EVSE status: ${aggregatedStatus} for EVSE ${connectorDto.evseId}`,
      );

      await this.locationsBroadcaster.broadcastPatchEvseStatus(
        tenant,
        evseDto,
        aggregatedStatus,
      );
    } else {
      // Non-status updates should be broadcasted at connector level
      await this.locationsBroadcaster.broadcastPatchConnector(
        tenant,
        connectorDto,
      );
    }
  }

  private isStatusOnlyUpdate(connectorDto: Partial<IConnectorDto>): boolean {
    // Get all keys except metadata fields
    const updateKeys = Object.keys(connectorDto).filter(
      (key) =>
        ![
          'id',
          'evseId',
          'stationId',
          'tenant',
          'tenantId',
          'chargingStation',
          'updatedAt',
          'createdAt',
          'timestamp',
        ].includes(key),
    );

    // If only status field is being updated
    return updateKeys.length === 1 && updateKeys.includes('status');
  }
}
