// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { BaseClientApi } from './BaseClientApi';
import {
  ConnectorDTO,
  ConnectorResponse,
  ConnectorResponseSchema,
} from '../model/DTO/ConnectorDTO';
import {
  LocationDTO,
  LocationResponse,
  LocationResponseSchema,
} from '../model/DTO/LocationDTO';
import {
  OcpiEmptyResponse,
  OcpiEmptyResponseSchema,
} from '../model/OcpiEmptyResponse';
import {
  EvseDTO,
  EvseResponse,
  EvseResponseSchema,
} from '../model/DTO/EvseDTO';
import { Service } from 'typedi';
import { ModuleId } from '../model/ModuleId';
import { EndpointIdentifier } from '../model/EndpointIdentifier';
import { HttpMethod, OCPIRegistration } from '@citrineos/base';

@Service()
export class LocationsClientApi extends BaseClientApi {
  CONTROLLER_PATH = ModuleId.Locations;

  getUrl(partnerProfile: OCPIRegistration.PartnerProfile): string {
    const url = partnerProfile.endpoints?.find(
      (value: OCPIRegistration.Endpoint) =>
        value.identifier === EndpointIdentifier.LOCATIONS_RECEIVER,
    )?.url;
    if (!url) {
      throw new Error(
        `No Locations endpoint available for partnerProfile ${JSON.stringify(partnerProfile)}`,
      );
    }
    return url;
  }

  async getConnector(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    evseUid: string,
    connectorId: string,
  ): Promise<ConnectorResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}/${evseUid}/${connectorId}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Get,
      schema: ConnectorResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      locationId,
    });
  }

  async getEvse(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    evseUid: string,
  ): Promise<EvseResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}/${evseUid}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Get,
      schema: EvseResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      locationId,
    });
  }

  async getLocation(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
  ): Promise<LocationResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Get,
      schema: LocationResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      locationId,
    });
  }

  async patchConnector(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    evseUid: string,
    connectorId: string,
    requestBody: Partial<ConnectorDTO>,
  ): Promise<OcpiEmptyResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}/${evseUid}/${connectorId}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Patch,
      schema: OcpiEmptyResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      body: requestBody,
      locationId,
    });
  }

  async patchEvse(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    evseUid: string,
    requestBody: Partial<EvseDTO>,
  ): Promise<OcpiEmptyResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}/${evseUid}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Patch,
      schema: OcpiEmptyResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      body: requestBody,
      locationId,
    });
  }

  async patchLocation(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    requestBody: Partial<LocationDTO>,
  ): Promise<OcpiEmptyResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Patch,
      schema: OcpiEmptyResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      body: requestBody,
      locationId,
    });
  }

  async putConnector(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    evseUid: string,
    connectorId: string,
    connector: ConnectorDTO,
  ): Promise<OcpiEmptyResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}/${evseUid}/${connectorId}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Put,
      schema: OcpiEmptyResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      body: connector,
      locationId,
    });
  }

  async putEvse(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    evseUid: string,
    evse: EvseDTO,
  ): Promise<OcpiEmptyResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}/${evseUid}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Put,
      schema: OcpiEmptyResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      body: evse,
      locationId,
    });
  }

  async putLocation(
    fromCountryCode: string,
    fromPartyId: string,
    toCountryCode: string,
    toPartyId: string,
    partnerProfile: OCPIRegistration.PartnerProfile,
    locationId: string,
    location: LocationDTO,
  ): Promise<OcpiEmptyResponse> {
    const path = `${fromCountryCode}/${fromPartyId}/${locationId}`;
    return this.request({
      fromCountryCode,
      fromPartyId,
      toCountryCode,
      toPartyId,
      httpMethod: HttpMethod.Put,
      schema: OcpiEmptyResponseSchema,
      partnerProfile,
      url: `${this.getUrl(partnerProfile)}/${path}`,
      body: location,
      locationId,
    });
  }
}
