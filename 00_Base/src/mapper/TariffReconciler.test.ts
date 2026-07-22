// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITariffDto } from '@citrineos/base';
import { ConnectorType } from '../model/ConnectorType';
import {
  reconcileEvseConnectorTariffs,
  ReconcilerInput,
} from './TariffReconciler';

function makeTariff(overrides: Partial<ITariffDto>): ITariffDto {
  return {
    id: 1,
    stationId: 'station-1',
    currency: 'USD',
    pricePerKwh: 0.5,
    pricePerMin: null,
    pricePerSession: null,
    authorizationAmount: null,
    paymentFee: null,
    taxRate: null,
    ...overrides,
  } as ITariffDto;
}

function makeConnector(overrides: Partial<ReconcilerInput>): ReconcilerInput {
  return {
    connectorId: 1,
    standard: ConnectorType.IEC_62196_T2,
    tariffIds: [],
    tariffs: [],
    ...overrides,
  };
}

describe('reconcileEvseConnectorTariffs', () => {
  it('1. same-standard connectors with identical tariff_ids: unchanged, no messages', () => {
    const tariff = makeTariff({ id: 10 });
    const connectors: ReconcilerInput[] = [
      makeConnector({ connectorId: 1, tariffIds: ['10'], tariffs: [tariff] }),
      makeConnector({ connectorId: 2, tariffIds: ['10'], tariffs: [tariff] }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(1)).toEqual(['10']);
    expect(result.tariffIdsByConnectorId.get(2)).toEqual(['10']);
    expect(result.warnings).toEqual([]);
    expect(result.infos).toEqual([]);
  });

  it('2. same-standard connectors with different tariff_ids but identical content: normalized to canonical, one info, no warn', () => {
    const tariffA = makeTariff({ id: 10, currency: 'USD', pricePerKwh: 0.5 });
    const tariffB = makeTariff({ id: 20, currency: 'USD', pricePerKwh: 0.5 });
    const connectors: ReconcilerInput[] = [
      makeConnector({ connectorId: 2, tariffIds: ['20'], tariffs: [tariffB] }),
      makeConnector({ connectorId: 1, tariffIds: ['10'], tariffs: [tariffA] }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(1)).toEqual(['10']);
    expect(result.tariffIdsByConnectorId.get(2)).toEqual(['10']);
    expect(result.infos).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('3. same-standard connectors with different tariff_ids and different content: normalized to canonical, one warn', () => {
    const tariffA = makeTariff({ id: 10, currency: 'USD', pricePerKwh: 0.5 });
    const tariffB = makeTariff({ id: 20, currency: 'USD', pricePerKwh: 0.75 });
    const connectors: ReconcilerInput[] = [
      makeConnector({ connectorId: 1, tariffIds: ['10'], tariffs: [tariffA] }),
      makeConnector({ connectorId: 2, tariffIds: ['20'], tariffs: [tariffB] }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(1)).toEqual(['10']);
    expect(result.tariffIdsByConnectorId.get(2)).toEqual(['10']);
    expect(result.warnings).toHaveLength(1);
    expect(result.infos).toEqual([]);
  });

  it('4. different-standard connectors with different tariffs: both preserved unchanged, no messages', () => {
    const tariffA = makeTariff({ id: 10, currency: 'USD', pricePerKwh: 0.5 });
    const tariffB = makeTariff({ id: 20, currency: 'EUR', pricePerKwh: 0.75 });
    const connectors: ReconcilerInput[] = [
      makeConnector({
        connectorId: 1,
        standard: ConnectorType.IEC_62196_T2,
        tariffIds: ['10'],
        tariffs: [tariffA],
      }),
      makeConnector({
        connectorId: 2,
        standard: ConnectorType.CHADEMO,
        tariffIds: ['20'],
        tariffs: [tariffB],
      }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(1)).toEqual(['10']);
    expect(result.tariffIdsByConnectorId.get(2)).toEqual(['20']);
    expect(result.warnings).toEqual([]);
    expect(result.infos).toEqual([]);
  });

  it('5. canonical selection uses lowest connectorId regardless of input order', () => {
    const tariffLow = makeTariff({ id: 5, currency: 'USD', pricePerKwh: 0.3 });
    const tariffHigh = makeTariff({
      id: 99,
      currency: 'USD',
      pricePerKwh: 0.9,
    });
    // Deliberately out of id order: highest id first, lowest id last.
    const connectors: ReconcilerInput[] = [
      makeConnector({
        connectorId: 30,
        tariffIds: ['99'],
        tariffs: [tariffHigh],
      }),
      makeConnector({
        connectorId: 20,
        tariffIds: ['5', '99'],
        tariffs: [tariffLow, tariffHigh],
      }),
      makeConnector({
        connectorId: 5,
        tariffIds: ['5'],
        tariffs: [tariffLow],
      }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(5)).toEqual(['5']);
    expect(result.tariffIdsByConnectorId.get(20)).toEqual(['5']);
    expect(result.tariffIdsByConnectorId.get(30)).toEqual(['5']);
    expect(result.warnings).toHaveLength(1);
  });

  it('6a. single connector: no-op, no messages', () => {
    const connectors: ReconcilerInput[] = [
      makeConnector({ connectorId: 1, tariffIds: ['10'] }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(1)).toEqual(['10']);
    expect(result.warnings).toEqual([]);
    expect(result.infos).toEqual([]);
  });

  it('6b. empty connector list: no-op, no messages, no throw', () => {
    const result = reconcileEvseConnectorTariffs([]);

    expect(result.tariffIdsByConnectorId.size).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.infos).toEqual([]);
  });

  it('7. one connector has tariffs, the other in the same group has none: normalized to canonical with a message', () => {
    const tariffA = makeTariff({ id: 10, currency: 'USD', pricePerKwh: 0.5 });
    const connectors: ReconcilerInput[] = [
      makeConnector({ connectorId: 1, tariffIds: ['10'], tariffs: [tariffA] }),
      makeConnector({ connectorId: 2, tariffIds: [], tariffs: [] }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(1)).toEqual(['10']);
    expect(result.tariffIdsByConnectorId.get(2)).toEqual(['10']);
    // Only one distinct tariff is referenced across the group (the other
    // member has none), so there is nothing to conflict on -> info, not warn.
    expect(result.infos).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('8. same-standard connectors whose tariff_ids are the same set in different order: treated as equal, unchanged, no messages', () => {
    const tariff = makeTariff({ id: 10 });
    const connectors: ReconcilerInput[] = [
      makeConnector({
        connectorId: 1,
        tariffIds: ['10', '20'],
        tariffs: [tariff],
      }),
      makeConnector({
        connectorId: 2,
        tariffIds: ['20', '10'],
        tariffs: [tariff],
      }),
    ];

    const result = reconcileEvseConnectorTariffs(connectors);

    expect(result.tariffIdsByConnectorId.get(1)).toEqual(['10', '20']);
    expect(result.tariffIdsByConnectorId.get(2)).toEqual(['20', '10']);
    expect(result.warnings).toEqual([]);
    expect(result.infos).toEqual([]);
  });

  it('never throws on empty tariffs within a divergent group', () => {
    const connectors: ReconcilerInput[] = [
      makeConnector({ connectorId: 1, tariffIds: ['10'], tariffs: [] }),
      makeConnector({ connectorId: 2, tariffIds: [], tariffs: [] }),
    ];

    expect(() => reconcileEvseConnectorTariffs(connectors)).not.toThrow();
  });
});
