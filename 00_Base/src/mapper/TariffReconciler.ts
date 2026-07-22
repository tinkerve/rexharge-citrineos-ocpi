// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITariffDto } from '@citrineos/base';
import { ConnectorType } from '../model/ConnectorType';

/**
 * Input for a single connector's tariff reconciliation, keyed by the raw
 * (global) connector id — NOT the EVSE-relative connectorId on IConnectorDto.
 */
export interface ReconcilerInput {
  connectorId: number;
  standard: ConnectorType | undefined;
  tariffIds: string[];
  tariffs: ITariffDto[];
}

export interface ReconcilerResult {
  tariffIdsByConnectorId: Map<number, string[]>;
  warnings: string[];
  infos: string[];
}

/** Fields compared to decide whether two tariff rows are content-identical. */
const TARIFF_CONTENT_FIELDS: (keyof ITariffDto)[] = [
  'currency',
  'pricePerKwh',
  'pricePerMin',
  'pricePerSession',
  'authorizationAmount',
  'paymentFee',
  'taxRate',
];

function tariffContentEquals(a: ITariffDto, b: ITariffDto): boolean {
  return TARIFF_CONTENT_FIELDS.every((field) => a[field] === b[field]);
}

function sameTariffIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}

/**
 * Given the referenced tariff rows (deduped by id) for a divergent group,
 * decide whether the divergence is benign (identical content, e.g.
 * duplicate tariff rows) or a genuine conflict (differing content).
 */
function isContentIdentical(tariffsById: Map<string, ITariffDto>): boolean {
  const tariffList = Array.from(tariffsById.values());
  if (tariffList.length <= 1) {
    // Zero or one distinct referenced tariff across the group -> nothing to
    // conflict on (e.g. one member has no tariff at all while another
    // references exactly one). Treated as benign, not a content conflict.
    return true;
  }
  const [first, ...rest] = tariffList;
  return rest.every((t) => tariffContentEquals(first, t));
}

/**
 * Pure, deterministic reconciler: given all connectors of a single EVSE,
 * ensure every connector sharing the same `standard` (OCPI ConnectorType)
 * exposes the same tariff_ids — normalizing to the canonical member (lowest
 * connectorId) when they diverge, and classifying the divergence as an
 * `info` (benign duplicate tariff content) or a `warn` (genuine conflict).
 *
 * No I/O, no DI — safe to unit test in isolation and safe to call for every
 * EVSE mapping without a live container.
 */
export function reconcileEvseConnectorTariffs(
  connectors: ReconcilerInput[],
): ReconcilerResult {
  const tariffIdsByConnectorId = new Map<number, string[]>();
  const warnings: string[] = [];
  const infos: string[] = [];

  if (!connectors || connectors.length <= 1) {
    connectors?.forEach((c) =>
      tariffIdsByConnectorId.set(c.connectorId, [...c.tariffIds]),
    );
    return { tariffIdsByConnectorId, warnings, infos };
  }

  const groups = new Map<string, ReconcilerInput[]>();
  for (const connector of connectors) {
    const key = connector.standard ?? '__UNKNOWN__';
    const group = groups.get(key);
    if (group) {
      group.push(connector);
    } else {
      groups.set(key, [connector]);
    }
  }

  for (const group of groups.values()) {
    if (group.length <= 1) {
      tariffIdsByConnectorId.set(group[0].connectorId, [
        ...group[0].tariffIds,
      ]);
      continue;
    }

    const allSame = group.every((member) =>
      sameTariffIdSet(member.tariffIds, group[0].tariffIds),
    );
    if (allSame) {
      group.forEach((member) =>
        tariffIdsByConnectorId.set(member.connectorId, [...member.tariffIds]),
      );
      continue;
    }

    // Divergent group: canonical = member with the lowest connectorId.
    const canonical = group.reduce((lowest, member) =>
      member.connectorId < lowest.connectorId ? member : lowest,
    );

    group.forEach((member) =>
      tariffIdsByConnectorId.set(member.connectorId, [...canonical.tariffIds]),
    );

    // Classify divergence by content: dedupe referenced tariffs by id.
    const tariffsById = new Map<string, ITariffDto>();
    for (const member of group) {
      for (const tariff of member.tariffs) {
        if (tariff.id !== undefined && tariff.id !== null) {
          tariffsById.set(tariff.id.toString(), tariff);
        }
      }
    }

    const connectorIds = group.map((m) => m.connectorId).join(', ');
    const tariffIdSets = group
      .map((m) => `${m.connectorId}:[${m.tariffIds.join(',')}]`)
      .join(', ');
    const stationId = group.find((m) => m.tariffs.length > 0)?.tariffs[0]
      ?.stationId;
    const stationInfo = stationId ? `stationId=${stationId} ` : '';

    if (isContentIdentical(tariffsById)) {
      infos.push(
        `${stationInfo}Duplicate tariff content across connectors [${connectorIds}] with divergent tariff_ids ${tariffIdSets}; normalized to canonical tariff_ids ${JSON.stringify(canonical.tariffIds)}.`,
      );
    } else {
      warnings.push(
        `${stationInfo}Conflicting tariff content across connectors [${connectorIds}] with divergent tariff_ids ${tariffIdSets}; normalized to canonical tariff_ids ${JSON.stringify(canonical.tariffIds)}.`,
      );
    }
  }

  return { tariffIdsByConnectorId, warnings, infos };
}
