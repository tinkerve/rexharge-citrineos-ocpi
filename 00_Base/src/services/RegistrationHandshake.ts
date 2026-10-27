// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { v4 as uuidv4 } from 'uuid';
import { Inject, Service } from 'typedi';
import { NotFoundError } from 'routing-controllers';
import { ITenantPartnerDto } from '@citrineos/base';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { OcpiConfig, OcpiConfigToken } from '../config/ocpi.types';
import {
  CLEAR_TENANT_PARTNER_PROFILE,
  UPDATE_TENANT_PARTNER_PROFILE,
} from '../graphql/queries/tenant.mutations';
import { GET_TENANT_PARTNER_BY_CPO_AND_AND_CLIENT } from '../graphql/queries/tenantPartner.queries';
import {
  GetTenantPartnerByCpoClientAndModuleIdQueryResult,
  GetTenantPartnerByCpoClientAndModuleIdQueryVariables,
  UpdateTenantPartnerProfileMutationResult,
  UpdateTenantPartnerProfileMutationVariables,
} from '../graphql/operations';
import { AlreadyRegisteredException } from '../exception/AlreadyRegisteredException';
import { NotRegisteredException } from '../exception/NotRegisteredException';
import { InvalidParamException } from '../exception/InvalidParamException';
import { VersionNumber } from '../model/VersionNumber';
import { VersionsClientApi } from '../trigger/VersionsClientApi';
import { CredentialsClientApi } from '../trigger/CredentialsClientApi';
import { RegistrationMapper } from '../mapper/RegistrationMapper';
import { CredentialsRoleDTO } from '../model/DTO/CredentialsRoleDTO';
import { Endpoint } from '../model/Endpoint';
import { partnerAnswered, redactError } from '../util/redactError';
import { CredentialsDTO } from '../model/DTO/CredentialsDTO';
import { RegistrationHandshakeException } from '../exception/RegistrationHandshakeException';

export { RegistrationHandshakeException };

/** Identifies one partner of one of our CPO tenants. */
export interface PartnerIdentity {
  cpoCountryCode: string;
  cpoPartyId: string;
  mspCountryCode: string;
  mspPartyId: string;
}

/** The setup token and versions URL an MSP gave us out of band. */
export interface PartnerSetupToken {
  token: string;
  url: string;
}

/** How a reset went for the partner; our side is always cleared. */
export interface ResetOutcome {
  partnerNotified: boolean;
  /** Redacted reason the partner could not be told, if we tried. */
  reason?: string;
}

/** How long a reset waits for the partner before clearing our side anyway. */
const RESET_NOTIFY_TIMEOUT_MS = 10_000;

/**
 * How long any single call to a partner may take during an exchange. Three
 * such calls (versions, details, credentials) stay inside the gateway's
 * timeout for the whole request.
 */
const PARTNER_CALL_TIMEOUT_MS = 15_000;

export interface IssuedSetupToken {
  token: string;
  versionsUrl: string;
  partner: ITenantPartnerDto;
}

/**
 * The partner registration handshake, seen from the CPO side.
 *
 * Owns every write to a partner's OCPI profile made on an admin's behalf. Each
 * write merges into the stored profile rather than replacing it, so nothing a
 * previous step recorded is silently dropped.
 */
@Service()
export class RegistrationHandshake {
  constructor(
    private readonly ocpiGraphqlClient: OcpiGraphqlClient,
    @Inject(OcpiConfigToken) private readonly config: OcpiConfig,
    private readonly versionsClient: VersionsClientApi,
    private readonly credentialsClient: CredentialsClientApi,
  ) {}

  /**
   * CPO-issued flow, first half: mint the setup token the MSP will call us
   * with, alongside the versions URL they call. No call is made to the MSP.
   *
   * Refused while the partner already holds a token we issued — whether a
   * pending setup token or a live one — so a working partnership cannot be
   * clobbered by a stray mint.
   */
  async issueSetupToken(
    identity: PartnerIdentity,
    versionNumber: VersionNumber,
    versionsUrlOverride?: string,
  ): Promise<IssuedSetupToken> {
    const partner = await this.findPartner(identity);
    const profile = partner.partnerProfileOCPI as any;

    if (profile?.serverCredentials?.token) {
      throw new AlreadyRegisteredException();
    }

    const versionsUrl =
      versionsUrlOverride ?? this.ourVersionsUrl(partner.tenantId!);
    const token = uuidv4();
    // Without a token of ours there is no live exchange, so any partner
    // credentials here are leftovers (the old partner form wrote empty ones).
    const {
      credentials: _leftover,
      initialCredentials: _legacy,
      ...kept
    } = profile ?? {};
    const merged = {
      ...kept,
      serverCredentials: { token, versionsUrl },
      version: profile?.version ?? { version: versionNumber },
    };

    await this.writeProfile(partner.id!, merged);
    partner.partnerProfileOCPI = merged;
    return { token, versionsUrl, partner };
  }

  /**
   * Withdraws a setup token that has not been used yet, so one sent in error
   * stops working. A partnership that has completed the exchange is not
   * cancelled — it is reset.
   */
  async cancelSetupToken(identity: PartnerIdentity): Promise<void> {
    const partner = await this.findPartner(identity);
    const profile = partner.partnerProfileOCPI as any;

    if (profile?.credentials?.token) {
      throw new AlreadyRegisteredException();
    }
    if (!profile?.serverCredentials?.token) {
      throw new NotRegisteredException();
    }

    const { serverCredentials: _withdrawn, ...rest } = profile;
    await this.writeProfile(partner.id!, rest);
  }

  /**
   * MSP-issued flow: the MSP gave us a setup token and their versions URL.
   * Discover their endpoints with it, send them a token of ours, and keep the
   * token they send back — which replaces the setup token, now dead.
   *
   * Our token is persisted before we post it, because the partner may call
   * our versions endpoint with it while answering. If anything fails, the
   * record is restored to how it was before the attempt, so a retry starts
   * clean; the error carries a redacted reason.
   */
  async completeFromPartnerToken(
    identity: PartnerIdentity,
    setup: PartnerSetupToken,
    versionNumber: VersionNumber,
    versionsUrlOverride?: string,
  ): Promise<void> {
    const partner = await this.findPartner(identity);
    const before = partner.partnerProfileOCPI as any;
    // A token of ours means an exchange is live or pending. Partner
    // credentials without one are leftovers, overwritten below.
    if (before?.serverCredentials?.token) {
      throw new AlreadyRegisteredException();
    }

    const ourToken = uuidv4();
    const secrets = [setup.token, ourToken];
    const profile: any = {
      ...(before ?? {}),
      version: before?.version ?? { version: versionNumber },
      credentials: { token: setup.token, versionsUrl: setup.url },
    };
    try {
      await this.discoverEndpoints(identity, profile, setup);
    } catch (error) {
      throw new RegistrationHandshakeException(redactError(error, secrets));
    }

    profile.serverCredentials = {
      token: ourToken,
      versionsUrl:
        versionsUrlOverride ?? this.ourVersionsUrl(partner.tenantId!),
    };
    partner.partnerProfileOCPI = profile;
    const ours = this.ourCredentials(partner, secrets);
    await this.exchangeTokens(partner.id!, before, profile, secrets, () =>
      this.credentialsClient.postCredentials(
        identity.cpoCountryCode,
        identity.cpoPartyId,
        identity.mspCountryCode,
        identity.mspPartyId,
        profile,
        ours,
        setup.token,
      ),
    );
  }

  /**
   * Re-keys a working partnership in place: a fresh token of ours goes to the
   * partner, and the fresh token they send back replaces theirs.
   *
   * Authenticates with the token the partner already issued us, so it only
   * makes sense on a registered partnership. Our new token is persisted
   * before it is sent, since the partner may call our versions endpoint with
   * it while answering. If the partner rejects the rotation, the previous
   * credentials are put back so the partnership keeps working.
   */
  async rotate(identity: PartnerIdentity): Promise<void> {
    const partner = await this.findPartner(identity);
    const before = partner.partnerProfileOCPI as any;
    if (!before?.credentials?.token || !before?.serverCredentials?.token) {
      throw new NotRegisteredException();
    }

    const ourToken = uuidv4();
    const secrets = [
      ourToken,
      before.credentials.token,
      before.serverCredentials.token,
    ];
    const profile: any = {
      ...structuredClone(before),
      serverCredentials: { ...before.serverCredentials, token: ourToken },
    };
    partner.partnerProfileOCPI = profile;
    const ours = this.ourCredentials(partner, secrets);
    await this.exchangeTokens(partner.id!, before, profile, secrets, () =>
      this.credentialsClient.putCredentials(
        identity.cpoCountryCode,
        identity.cpoPartyId,
        identity.mspCountryCode,
        identity.mspPartyId,
        profile,
        ours,
      ),
    );
  }

  /**
   * Puts a partnership back to "not started" on the same partner record.
   *
   * Tells the partner first (DELETE /credentials with the token they issued
   * us), because clearing first would destroy the token needed to tell them.
   * Best-effort: an unreachable or silent partner never wedges our record —
   * our side is cleared either way. Only the OCPI profile is touched; driver
   * authorizations are deliberately left alone, since a reset partner is
   * expected straight back.
   */
  async reset(identity: PartnerIdentity): Promise<ResetOutcome> {
    const partner = await this.findPartner(identity);
    const profile = partner.partnerProfileOCPI as any;

    let outcome: ResetOutcome = { partnerNotified: false };
    if (profile?.credentials?.token) {
      try {
        await withTimeout(
          this.credentialsClient.deleteCredentials(
            identity.cpoCountryCode,
            identity.cpoPartyId,
            identity.mspCountryCode,
            identity.mspPartyId,
            profile,
          ),
          RESET_NOTIFY_TIMEOUT_MS,
        );
        outcome = { partnerNotified: true };
      } catch (error) {
        outcome = {
          partnerNotified: false,
          reason: redactError(error, [
            profile.credentials.token,
            profile.serverCredentials?.token,
          ]),
        };
      }
    }

    await this.ocpiGraphqlClient.request(CLEAR_TENANT_PARTNER_PROFILE, {
      partnerId: partner.id!,
    });
    return outcome;
  }

  /**
   * The part of every credentials exchange where tokens change hands.
   *
   * Our new token is persisted first — the partner may call our versions
   * endpoint with it while answering. What happens on failure depends on how
   * far it got:
   * - before the partner has handed us a token, the previous profile is put
   *   back; if the partner never gave a definite answer (timeout, dropped
   *   connection) the reason says they may have applied the change anyway;
   * - once the partner has handed us a token, they have switched to ours and
   *   dropped their old one, so nothing is put back: their answer is saved,
   *   retried once, and a save that still fails says the partnership needs a
   *   reset.
   */
  private async exchangeTokens(
    partnerId: number,
    before: unknown,
    profile: any,
    secrets: string[],
    send: () => Promise<{ data?: CredentialsDTO } | undefined>,
  ): Promise<void> {
    let wrote = false;
    let theirs: CredentialsDTO | undefined;
    try {
      await this.writeProfile(partnerId, profile);
      wrote = true;
      theirs = (await withTimeout(send(), PARTNER_CALL_TIMEOUT_MS))?.data;
      if (!theirs?.token) {
        throw new Error('Partner answered without a token');
      }
    } catch (error) {
      let reason = redactError(error, secrets);
      if (!partnerAnswered(error)) {
        reason +=
          '; the partner may have applied the change — check with them before trying again';
      }
      if (wrote) {
        const restored = await this.restoreProfile(partnerId, before).then(
          () => true,
          () => false,
        );
        if (!restored) reason += '; our record could not be put back';
      }
      throw new RegistrationHandshakeException(reason);
    }

    secrets.push(theirs.token);
    profile.credentials = { token: theirs.token, versionsUrl: theirs.url };
    profile.roles = theirs.roles.map((role: CredentialsRoleDTO) =>
      RegistrationMapper.toCredentialsRole(role),
    );
    try {
      await this.writeProfile(partnerId, profile).catch(() =>
        this.writeProfile(partnerId, profile),
      );
    } catch (error) {
      throw new RegistrationHandshakeException(
        `the partner accepted, but saving their new credentials failed (${redactError(error, secrets)}); reset the partnership and register again`,
      );
    }
  }

  private async discoverEndpoints(
    identity: PartnerIdentity,
    profile: any,
    setup: PartnerSetupToken,
  ): Promise<void> {
    const versions = await withTimeout(
      this.versionsClient.getVersions(
        identity.cpoCountryCode,
        identity.cpoPartyId,
        identity.mspCountryCode,
        identity.mspPartyId,
        profile,
        setup.url,
        setup.token,
      ),
      PARTNER_CALL_TIMEOUT_MS,
    );
    const wanted = profile.version.version;
    const match = versions?.data?.find((v) => v.version === wanted);
    if (!match) {
      throw new Error(`Partner does not offer OCPI ${wanted}`);
    }
    profile.version = { ...profile.version, versionDetailsUrl: match.url };

    const details = await withTimeout(
      this.versionsClient.getVersionDetails(
        identity.cpoCountryCode,
        identity.cpoPartyId,
        identity.mspCountryCode,
        identity.mspPartyId,
        profile,
        match.url,
        setup.token,
      ),
      PARTNER_CALL_TIMEOUT_MS,
    );
    profile.endpoints = (details?.data?.endpoints ?? []).map(
      (endpoint: Endpoint) => RegistrationMapper.toEndpoint(endpoint),
    );
  }

  /**
   * The credentials we send the partner, built before anything is written or
   * sent: a failure here is ours alone, so the partner cannot have applied
   * anything and the admin must not be told to check with them.
   */
  private ourCredentials(
    partner: ITenantPartnerDto,
    secrets: string[],
  ): CredentialsDTO {
    try {
      return RegistrationMapper.tenantPartnerToCredentialsDto(partner);
    } catch (error) {
      throw new RegistrationHandshakeException(redactError(error, secrets));
    }
  }

  private ourVersionsUrl(tenantId: number): string {
    const base = this.config.registration?.publicBaseUrl;
    if (!base) {
      throw new Error(
        'registration.publicBaseUrl is not configured; pass an explicit versions URL',
      );
    }
    return `${base.replace(/\/+$/, '')}/versions/${tenantId}`;
  }

  private async findPartner(
    identity: PartnerIdentity,
  ): Promise<ITenantPartnerDto> {
    const response = await this.ocpiGraphqlClient.request<
      GetTenantPartnerByCpoClientAndModuleIdQueryResult,
      GetTenantPartnerByCpoClientAndModuleIdQueryVariables
    >(GET_TENANT_PARTNER_BY_CPO_AND_AND_CLIENT, {
      cpoCountryCode: identity.cpoCountryCode,
      cpoPartyId: identity.cpoPartyId,
      clientCountryCode: identity.mspCountryCode,
      clientPartyId: identity.mspPartyId,
    });
    const partners = response.TenantPartners as ITenantPartnerDto[];
    const label = `${identity.mspCountryCode}/${identity.mspPartyId}`;

    if (partners.length === 0) {
      throw new NotFoundError(
        `No partner ${label} under CPO ${identity.cpoCountryCode}/${identity.cpoPartyId}`,
      );
    }
    if (partners.length > 1) {
      throw new InvalidParamException(
        `Partner ${label} matches ${partners.length} records; resolve the duplicate first`,
      );
    }
    return partners[0];
  }

  /** Puts the profile back as it was — including back to none at all. */
  private async restoreProfile(partnerId: number, profile: unknown) {
    if (profile == null) {
      await this.ocpiGraphqlClient.request(CLEAR_TENANT_PARTNER_PROFILE, {
        partnerId,
      });
      return;
    }
    await this.writeProfile(partnerId, profile);
  }

  private async writeProfile(partnerId: number, profile: unknown) {
    await this.ocpiGraphqlClient.request<
      UpdateTenantPartnerProfileMutationResult,
      UpdateTenantPartnerProfileMutationVariables
    >(UPDATE_TENANT_PARTNER_PROFILE, {
      partnerId,
      input: profile as UpdateTenantPartnerProfileMutationVariables['input'],
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`No answer within ${ms} ms`), {
            code: 'ETIMEDOUT',
          }),
        ),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
