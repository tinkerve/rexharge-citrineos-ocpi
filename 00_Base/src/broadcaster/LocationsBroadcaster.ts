// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  HttpMethod,
  IConnectorDto,
  IEvseDto,
  ILocationDto,
  ITenantDto,
} from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { Service } from 'typedi';
import {
  ConnectorMapper,
  EvseMapper,
  LocationMapper,
} from '../mapper/LocationMapper';
import { ConnectorDTO } from '../model/DTO/ConnectorDTO';
import { EvseDTO, UID_FORMAT } from '../model/DTO/EvseDTO';
import { LocationDTO } from '../model/DTO/LocationDTO';
import { EvseStatus } from '../model/EvseStatus';
import { InterfaceRole } from '../model/InterfaceRole';
import { ModuleId } from '../model/ModuleId';
import { OcpiEmptyResponseSchema } from '../model/OcpiEmptyResponse';
import { CredentialsService } from '../services/CredentialsService';
import { LocationsClientApi } from '../trigger/LocationsClientApi';
import { toISOStringIfNeeded } from '../util/DateTimeHelper';
import { BaseBroadcaster } from './BaseBroadcaster';

@Service()
export class LocationsBroadcaster extends BaseBroadcaster {
  constructor(
    readonly logger: Logger<ILogObj>,
    readonly credentialsService: CredentialsService,
    readonly locationsClientApi: LocationsClientApi,
  ) {
    super();
  }

  async broadcastPutLocation(
    tenant: ITenantDto,
    locationDto: ILocationDto,
  ): Promise<void> {
    const location = LocationMapper.fromGraphql(locationDto);
    const path = `/${tenant.countryCode}/${tenant.partyId}/${location.id}`;
    await this.broadcastLocation(
      tenant,
      location,
      HttpMethod.Put,
      path,
      locationDto.id,
    );
  }

  async broadcastPatchLocation(
    tenant: ITenantDto,
    locationDto: Partial<ILocationDto>,
  ): Promise<void> {
    const locationId = locationDto.id;
    if (!locationId) throw new Error('Location ID missing');
    const location = LocationMapper.fromPartialGraphql(locationDto);
    const path = `/${tenant.countryCode}/${tenant.partyId}/${locationId}`;
    await this.broadcastLocation(
      tenant,
      location,
      HttpMethod.Patch,
      path,
      locationId,
    );
  }

  private async broadcastLocation(
    tenant: ITenantDto,
    location: Partial<LocationDTO>,
    method: HttpMethod,
    path: string,
    locationId?: number,
  ): Promise<void> {
    try {
      await this.locationsClientApi.broadcastToClients({
        cpoCountryCode: tenant.countryCode!,
        cpoPartyId: tenant.partyId!,
        moduleId: ModuleId.Locations,
        interfaceRole: InterfaceRole.RECEIVER,
        httpMethod: method,
        schema: OcpiEmptyResponseSchema,
        body: location,
        path: path,
        locationId,
      });
    } catch (e) {
      this.logger.error(
        `broadcast${method}Location failed for Location ${path}`,
        e,
      );
    }
  }

  async broadcastPutEvse(tenant: ITenantDto, evseDto: IEvseDto): Promise<void> {
    const locationId = evseDto.chargingStation?.locationId;
    if (!locationId) throw new Error('Location ID missing in EVSE data');
    const evse = EvseMapper.fromGraphql(evseDto.chargingStation!, evseDto);
    if (!evse) throw new Error('Failed to map EVSE data');
    const path = `/${tenant.countryCode}/${tenant.partyId}/${locationId}/${UID_FORMAT(evseDto.stationId, evseDto.id!)}`;
    await this.broadcastEvse(tenant, evse, HttpMethod.Put, path, locationId);
  }

  async broadcastPatchEvseStatus(
    tenant: ITenantDto,
    evseDto: Partial<IEvseDto>,
    aggregatedStatus: EvseStatus,
  ): Promise<void> {
    const locationId = evseDto.chargingStation?.locationId;
    if (!locationId) throw new Error('Location ID missing in EVSE data');
    const path = `/${tenant.countryCode}/${tenant.partyId}/${locationId}/${UID_FORMAT(evseDto.stationId!, evseDto.id!)}`;
    const evseData: Partial<EvseDTO> = {
      status: aggregatedStatus,
      last_updated: toISOStringIfNeeded(evseDto.updatedAt),
    };
    await this.broadcastEvse(
      tenant,
      evseData,
      HttpMethod.Patch,
      path,
      locationId,
    );
  }

  async broadcastPatchEvse(
    tenant: ITenantDto,
    evseDto: Partial<IEvseDto>,
  ): Promise<void> {
    const locationId = evseDto.chargingStation?.locationId;
    if (!locationId) throw new Error('Location ID missing in EVSE data');
    const evse = EvseMapper.fromPartialGraphql(
      evseDto.chargingStation!,
      evseDto,
    );
    if (!evse) throw new Error('Failed to map EVSE data');
    const path = `/${tenant.countryCode}/${tenant.partyId}/${locationId}/${UID_FORMAT(evseDto.stationId!, evseDto.id!)}`;
    await this.broadcastEvse(tenant, evse, HttpMethod.Patch, path, locationId);
  }

  private async broadcastEvse(
    tenant: ITenantDto,
    evseData: Partial<EvseDTO>,
    method: HttpMethod,
    path: string,
    locationId?: number,
  ): Promise<void> {
    try {
      await this.locationsClientApi.broadcastToClients({
        cpoCountryCode: tenant.countryCode!,
        cpoPartyId: tenant.partyId!,
        moduleId: ModuleId.Locations,
        interfaceRole: InterfaceRole.RECEIVER,
        httpMethod: method,
        schema: OcpiEmptyResponseSchema,
        body: evseData,
        path: path,
        locationId,
      });
    } catch (e) {
      this.logger.error(`broadcast${method}Evse failed for ${path}`, e);
    }
  }

  async broadcastPutConnector(
    tenant: ITenantDto,
    connectorDto: IConnectorDto,
  ): Promise<void> {
    const locationId = connectorDto.chargingStation?.locationId;
    if (!locationId) throw new Error('Location ID missing in Connector data');
    const connector = ConnectorMapper.fromGraphql(connectorDto);
    if (!connector) throw new Error('Failed to map Connector data');
    const path = `/${tenant.countryCode}/${tenant.partyId}/${locationId}/${UID_FORMAT(connectorDto.stationId, connectorDto.evseId)}/${connectorDto.id}`;
    await this.broadcastConnector(
      tenant,
      connector,
      HttpMethod.Put,
      path,
      locationId,
    );
  }

  async broadcastPatchConnector(
    tenant: ITenantDto,
    connectorDto: Partial<IConnectorDto>,
  ): Promise<void> {
    const locationId = connectorDto.chargingStation?.locationId;
    if (!locationId) throw new Error('Location ID missing in Connector data');
    const connector = ConnectorMapper.fromPartialGraphql(connectorDto);
    if (!connector) throw new Error('Failed to map Connector data');
    const path = `/${tenant.countryCode}/${tenant.partyId}/${locationId}/${UID_FORMAT(connectorDto.stationId!, connectorDto.evseId!)}/${connectorDto.id}`;
    await this.broadcastConnector(
      tenant,
      connector,
      HttpMethod.Patch,
      path,
      locationId,
    );
  }

  private async broadcastConnector(
    tenant: ITenantDto,
    connectorData: Partial<ConnectorDTO>,
    method: HttpMethod,
    path: string,
    locationId?: number,
  ): Promise<void> {
    try {
      await this.locationsClientApi.broadcastToClients({
        cpoCountryCode: tenant.countryCode!,
        cpoPartyId: tenant.partyId!,
        moduleId: ModuleId.Locations,
        interfaceRole: InterfaceRole.RECEIVER,
        httpMethod: method,
        schema: OcpiEmptyResponseSchema,
        body: connectorData,
        path: path,
        locationId,
      });
    } catch (e) {
      this.logger.error(`broadcast${method}Connector failed for ${path}`, e);
    }
  }
}
