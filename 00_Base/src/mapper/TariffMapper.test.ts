// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITariffDto } from '@citrineos/base';
import { TariffDimensionType } from '../model/TariffDimensionType';
import { TariffMapper } from './TariffMapper';

// Focus: the min_power restriction we publish alongside a TIME price component.
//
// Our CDR already refuses to bill time a charger did not deliver, but the eMSP
// prices their own driver from this tariff rather than from our CDR. Without
// min_power the two disagree, and a driver can be charged for a warm-up we
// deliberately did not invoice the partner for.
describe('TariffMapper.map — TIME power restriction', () => {
  const baseTariff = (overrides: Partial<ITariffDto> = {}): ITariffDto =>
    ({
      id: 35,
      currency: 'MYR',
      tenant: { countryCode: 'MY', partyId: 'REX' },
      updatedAt: '2026-08-05T05:58:25.601Z',
      pricePerKwh: null,
      pricePerMin: null,
      pricePerSession: null,
      taxRate: null,
      ...overrides,
    }) as unknown as ITariffDto;

  const componentsOf = (
    elements: ReturnType<typeof TariffMapper.map>['elements'],
  ) => elements.flatMap((element) => element.price_components ?? []);

  afterEach(() => {
    delete process.env.BILLING_MIN_POWER_KW;
  });

  it('puts TIME in its own element carrying min_power', () => {
    // Production tariff 35: time-only, on a station shared with a roaming partner.
    const dto = TariffMapper.map(
      baseTariff({ pricePerKwh: 0.0, pricePerMin: 0.6 } as Partial<ITariffDto>),
    );

    expect(dto.elements).toHaveLength(1);
    expect(dto.elements[0].price_components).toEqual([
      {
        type: TariffDimensionType.TIME,
        price: 36, // 0.6/min published as a per-hour rate
        vat: 0,
        step_size: 60,
      },
    ]);
    expect(dto.elements[0].restrictions).toEqual({ min_power: 0.1 });
  });

  it('leaves ENERGY and FLAT unrestricted, in a separate element', () => {
    const dto = TariffMapper.map(
      baseTariff({
        pricePerKwh: 0.2,
        pricePerMin: 0.6,
        pricePerSession: 1.5,
      } as Partial<ITariffDto>),
    );

    expect(dto.elements).toHaveLength(2);

    const [unrestricted, restricted] = dto.elements;
    expect(unrestricted.restrictions).toBeUndefined();
    expect(unrestricted.price_components?.map((c) => c.type)).toEqual([
      TariffDimensionType.ENERGY,
      TariffDimensionType.FLAT,
    ]);

    expect(restricted.restrictions).toEqual({ min_power: 0.1 });
    expect(restricted.price_components?.map((c) => c.type)).toEqual([
      TariffDimensionType.TIME,
    ]);
  });

  it('emits a single unrestricted element when there is no time rate', () => {
    const dto = TariffMapper.map(
      baseTariff({ pricePerKwh: 0.2 } as Partial<ITariffDto>),
    );

    expect(dto.elements).toHaveLength(1);
    expect(dto.elements[0].restrictions).toBeUndefined();
    expect(dto.elements[0].price_components?.map((c) => c.type)).toEqual([
      TariffDimensionType.ENERGY,
    ]);
  });

  it('never emits an element with no price components', () => {
    const dto = TariffMapper.map(baseTariff());

    expect(dto.elements).toEqual([]);
  });

  it('honours a custom power floor', () => {
    process.env.BILLING_MIN_POWER_KW = '0.5';

    const dto = TariffMapper.map(
      baseTariff({ pricePerMin: 0.6 } as Partial<ITariffDto>),
    );

    expect(dto.elements[0].restrictions).toEqual({ min_power: 0.5 });
  });

  it('keeps the original single-element shape when the floor is disabled', () => {
    process.env.BILLING_MIN_POWER_KW = '0';

    const dto = TariffMapper.map(
      baseTariff({ pricePerKwh: 0.2, pricePerMin: 0.6 } as Partial<ITariffDto>),
    );

    expect(dto.elements).toHaveLength(1);
    expect(dto.elements[0].restrictions).toBeUndefined();
    expect(componentsOf(dto.elements).map((c) => c.type)).toEqual([
      TariffDimensionType.ENERGY,
      TariffDimensionType.TIME,
    ]);
  });

  it('carries VAT onto every component regardless of element', () => {
    const dto = TariffMapper.map(
      baseTariff({
        pricePerKwh: 0.2,
        pricePerMin: 0.6,
        taxRate: 0.08,
      } as Partial<ITariffDto>),
    );

    expect(componentsOf(dto.elements).every((c) => c.vat === 0.08)).toBe(true);
  });
});
