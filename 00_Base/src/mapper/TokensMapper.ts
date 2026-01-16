// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  AuthorizationStatusType,
  AuthorizationWhitelistType,
  IAuthorizationDto,
  IdTokenType,
  OCPP2_0_1,
} from '@citrineos/base';
import { TokenType } from '../model/TokenType';

import { TokenDTO } from '../model/DTO/TokenDTO';
import { WhitelistType } from '../model/WhitelistType';
import { toISOStringIfNeeded } from '../util/DateTimeHelper';
import { createHash } from 'crypto';

export class TokensMapper {
  public static toDto(authorization: IAuthorizationDto): TokenDTO {
    // Retrieve original token UID from customData if it exists, otherwise use normalized idToken
    // Note: customData exists in DB but not in TypeScript interface, so we use type assertion
    const originalTokenUid =
      (authorization as any).customData?.original_token_uid ||
      authorization.idToken;

    const tokenDto: TokenDTO = {
      country_code: authorization.tenantPartner!.countryCode!,
      party_id: authorization.tenantPartner!.partyId!,
      uid: originalTokenUid,
      type: TokensMapper.mapOcppIdTokenTypeToOcpiTokenType(
        authorization.idTokenType ? authorization.idTokenType : null,
      ),
      contract_id: this.getContractId(authorization),
      visual_number: TokensMapper.getVisualNumber(authorization),
      issuer: TokensMapper.getIssuer(authorization),
      group_id: authorization.groupAuthorization?.idToken,
      valid: authorization.status === AuthorizationStatusType.Accepted,
      whitelist: TokensMapper.mapRealTimeEnumType(authorization.realTimeAuth),
      language: authorization.language1,
      // default_profile_type: token.default_profile_type,
      // energy_contract: token.energy_contract,
      last_updated: toISOStringIfNeeded(authorization.updatedAt, true),
    };

    return tokenDto;
  }

  public static mapOcpiTokenTypeToOcppIdTokenType(
    type: TokenType,
  ): IdTokenType {
    switch (type) {
      case TokenType.RFID:
        // If you are actually using ISO15693, you need to change this
        return IdTokenType.ISO14443;
      case TokenType.AD_HOC_USER:
        return IdTokenType.Local;
      case TokenType.APP_USER:
        return IdTokenType.Central;
      case TokenType.OTHER:
        return IdTokenType.Other;
      default:
        throw new Error(`Unknown token type: ${type}`);
    }
  }

  public static mapOcppIdTokenTypeToOcpiTokenType(
    type: IdTokenType | null | undefined,
  ): TokenType {
    switch (type) {
      case IdTokenType.ISO14443:
        // If you are actually using ISO15693, you need to change this
        return TokenType.RFID;
      case IdTokenType.Local:
        return TokenType.AD_HOC_USER;
      case IdTokenType.Central:
        return TokenType.APP_USER;
      case null:
        return TokenType.OTHER;
      default:
        throw new Error(`Unknown token type: ${type}`);
    }
  }

  public static mapRealTimeEnumType(
    type: AuthorizationWhitelistType | null | undefined,
  ): WhitelistType {
    switch (type) {
      case AuthorizationWhitelistType.Allowed:
        return WhitelistType.ALLOWED;
      case AuthorizationWhitelistType.AllowedOffline:
        return WhitelistType.ALLOWED_OFFLINE;
      case AuthorizationWhitelistType.Never:
        return WhitelistType.NEVER;
      default:
        return WhitelistType.ALWAYS;
    }
  }

  public static mapWhitelistType(
    whitelist: WhitelistType | undefined,
  ): AuthorizationWhitelistType | null | undefined {
    switch (whitelist) {
      case WhitelistType.ALLOWED:
        return AuthorizationWhitelistType.Allowed;
      case WhitelistType.ALLOWED_OFFLINE:
        return AuthorizationWhitelistType.AllowedOffline;
      case WhitelistType.NEVER:
        return AuthorizationWhitelistType.Never;
      case WhitelistType.ALWAYS:
        return null;
      default:
        return undefined;
    }
  }

  public static mapOcpiTokenToPartialOcppAuthorization(
    tokenDto: Partial<TokenDTO>,
  ): Partial<IAuthorizationDto> {
    const originalTokenUid = tokenDto.uid;
    const idToken: string | undefined = TokensMapper.normalizeToken(
      tokenDto.uid,
    );
    const idTokenType: IdTokenType | undefined =
      tokenDto.type &&
      TokensMapper.mapOcpiTokenTypeToOcppIdTokenType(tokenDto.type);

    const partialAdditionalInfo: OCPP2_0_1.AdditionalInfoType[] = [];

    if (tokenDto.contract_id) {
      partialAdditionalInfo.push({
        additionalIdToken: tokenDto.contract_id,
        type: OCPP2_0_1.IdTokenEnumType.eMAID,
      });
    }
    if (tokenDto.visual_number) {
      partialAdditionalInfo.push({
        additionalIdToken: tokenDto.visual_number,
        type: 'visual_number',
      });
    } else {
      //use contract_id as visual_number if visual_number is not provided
      if (tokenDto.contract_id) {
        partialAdditionalInfo.push({
          additionalIdToken: tokenDto.contract_id,
          type: 'visual_number',
        });
      }
    }
    if (tokenDto.issuer) {
      partialAdditionalInfo.push({
        additionalIdToken: tokenDto.issuer,
        type: 'issuer',
      });
    }

    const additionalInfo:
      | [OCPP2_0_1.AdditionalInfoType, ...OCPP2_0_1.AdditionalInfoType[]]
      | undefined =
      partialAdditionalInfo.length > 0
        ? (partialAdditionalInfo as [
            OCPP2_0_1.AdditionalInfoType,
            ...OCPP2_0_1.AdditionalInfoType[],
          ])
        : undefined;

    const status: AuthorizationStatusType = tokenDto.valid
      ? AuthorizationStatusType.Accepted
      : AuthorizationStatusType.Invalid;

    const language1: string | undefined = tokenDto.language ?? undefined;

    const realTimeAuth: AuthorizationWhitelistType | null | undefined =
      TokensMapper.mapWhitelistType(tokenDto.whitelist);

    // Store original token UID in customData if it was normalized
    const customData =
      originalTokenUid && originalTokenUid !== idToken
        ? { original_token_uid: originalTokenUid }
        : undefined;

    // Note: customData exists in DB but not in IAuthorizationDto TypeScript interface
    // Return with type assertion to include customData
    const result: Partial<IAuthorizationDto> = {
      additionalInfo,
      idToken,
      idTokenType,
      status,
      language1,
      realTimeAuth,
    };

    if (customData) {
      (result as any).customData = customData;
    }

    return result;
  }

  public static getContractId(authorization: IAuthorizationDto): string {
    const contractId = authorization.additionalInfo!.find(
      (info) => info.type === OCPP2_0_1.IdTokenEnumType.eMAID,
    )?.additionalIdToken;
    if (!contractId) {
      throw new Error(
        'Contract ID not found in authorization additional info, authorization is incomplete for OCPI token mapping. Please add additional info with type eMAID.',
      );
    }
    return contractId;
  }

  public static getVisualNumber(authorization: IAuthorizationDto): string {
    const visualNumber = authorization.additionalInfo!.find(
      (info) => info.type === 'visual_number',
    )?.additionalIdToken;
    if (!visualNumber) {
      throw new Error(
        'Visual number not found in authorization additional info, authorization is incomplete for OCPI token mapping. Please add additional info with type visual_number.',
      );
    }
    return visualNumber;
  }

  public static getIssuer(authorization: IAuthorizationDto): string {
    const issuer = authorization.additionalInfo!.find(
      (info) => info.type === 'issuer',
    )?.additionalIdToken;
    if (!issuer) {
      throw new Error(
        'Issuer not found in authorization additional info, authorization is incomplete for OCPI token mapping. Please add additional info with type issuer.',
      );
    }
    return issuer;
  }

  // public static mapTokenDTOToPartialAuthorization(
  //   existingAuth: Authorization,
  //   tokenDTO: Partial<TokenDTO>,
  // ): Partial<OCPP2_0_1.IdTokenInfoType> {
  //   const idTokenInfo: Partial<OCPP2_0_1.IdTokenInfoType> = {
  //     status: existingAuth.idTokenInfo?.status,
  //   };

  //   if (tokenDTO.valid !== undefined) {
  //     idTokenInfo.status = tokenDTO.valid
  //       ? OCPP2_0_1.AuthorizationStatusEnumType.Accepted
  //       : OCPP2_0_1.AuthorizationStatusEnumType.Invalid;
  //   }

  //   if (tokenDTO.group_id) {
  //     idTokenInfo.groupIdToken = {
  //       idToken: tokenDTO.group_id,
  //       type: OcpiTokensMapper.mapOcpiTokenTypeToOcppIdTokenType(
  //         tokenDTO.type!,
  //       ),
  //     };
  //   }

  //   if (tokenDTO.language) {
  //     idTokenInfo.language1 = tokenDTO.language;
  //   }

  //   return idTokenInfo;
  // }

  public static toGraphqlWhere(token: TokenDTO): any {
    return {
      idToken: { _eq: token.uid },
      IdTokenType: {
        _eq: TokensMapper.mapOcpiTokenTypeToOcppIdTokenType(token.type),
      },
      TenantPartner: {
        countryCode: { _eq: token.country_code },
        partyId: { _eq: token.party_id },
      },
    };
  }

  public static toGraphqlSet(token: Partial<TokenDTO>): any {
    const set: any = TokensMapper.mapOcpiTokenToPartialOcppAuthorization(token);
    return set;
  }

  public static normalizeToken(
    tokenUid: string | undefined,
  ): string | undefined {
    if (!tokenUid) {
      return undefined;
    }

    if (tokenUid.length <= 20) {
      return tokenUid;
    }

    // Create a deterministic hash of the token UID
    // Take first 20 chars of hex hash (40 hex chars from SHA-256, we take half)
    const hash = createHash('sha256').update(tokenUid).digest('hex');
    return hash.substring(0, 20);
  }
}
