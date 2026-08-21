// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITariffDto } from '@citrineos/base';
import { TariffDTO } from '../model/DTO/tariffs/TariffDTO';
import { TariffDimensionType } from '../model/TariffDimensionType';
import { TariffElement } from '../model/TariffElement';
import { TariffType } from '../model/TariffType';
import {
  getBillingIdleRatePerMin,
  getBillingMinPowerKw,
  MINUTES_IN_HOUR,
} from '../util/Consts';
import { toISOStringIfNeeded } from '../util/DateTimeHelper';

export class TariffMapper {
  constructor() {}

  public static map(coreTariff: Partial<ITariffDto>): TariffDTO {
    return {
      id: coreTariff.id!.toString(),
      country_code: coreTariff.tenant!.countryCode!,
      party_id: coreTariff.tenant!.partyId!,
      currency: coreTariff.currency!,
      type: TariffType.REGULAR,
      // tariff_alt_text: coreTariff.tariffAltText
      //   ? (coreTariff.tariffAltText[0] as any)?.text
      //   : undefined,
      tariff_alt_url: undefined,
      min_price: undefined,
      max_price: undefined,
      elements: TariffMapper.getTariffElements(coreTariff),
      energy_mix: undefined,
      start_date_time: undefined,
      end_date_time: undefined,
      last_updated: toISOStringIfNeeded(coreTariff.updatedAt, true),
    };
  }
  /**
   * TIME is published in its own TariffElement carrying a min_power
   * restriction, because OCPI scopes restrictions to the whole element — "A
   * Tariff Element is a group of Price Components that share a set of
   * restrictions under which they apply" — so it cannot be attached to a single
   * price component.
   *
   * That restriction is what stops a partner billing their driver for a charger
   * that latched but never delivered. Our own CDR already refuses to bill it
   * (CdrMapper prices TIME on total_time - total_parking_time), but the partner
   * computes their driver's price from this tariff, not from our CDR. Without
   * min_power the two disagree.
   *
   * ENERGY and FLAT stay unrestricted: energy self-heals at zero kWh, and a
   * session fee is not a duration charge.
   */
  private static getTariffElements(
    coreTariff: Partial<ITariffDto>,
  ): TariffElement[] {
    const vat = coreTariff.taxRate ?? 0;
    const minPowerKw = getBillingMinPowerKw();

    const unrestricted = [
      ...(coreTariff.pricePerKwh
        ? [
            {
              type: TariffDimensionType.ENERGY,
              price: coreTariff.pricePerKwh,
              vat,
              step_size: 1,
            },
          ]
        : []),
      ...(coreTariff.pricePerSession
        ? [
            {
              type: TariffDimensionType.FLAT,
              price: coreTariff.pricePerSession,
              vat,
              step_size: 1,
            },
          ]
        : []),
    ];

    const time = coreTariff.pricePerMin
      ? [
          {
            type: TariffDimensionType.TIME,
            price: coreTariff.pricePerMin * MINUTES_IN_HOUR,
            vat,
            step_size: 60,
          },
        ]
      : [];

    // Idle rate for hogging a connector after charging finished. Published so a
    // partner can show the driver what they are exposed to, and so it matches
    // the total_parking_cost we invoice. It is configured per station rather
    // than carried on the tariff row, because the core Tariff model has no idle
    // column — see getBillingIdleRatePerMin.
    //
    // The free buffer is not expressible as a TariffRestriction: min_duration
    // gates on session length, not parking length. It is applied when measuring
    // the billable quantity in CdrMapper instead, so this component states the
    // rate only.
    const idleRatePerMin = getBillingIdleRatePerMin(coreTariff.stationId);
    const parking = idleRatePerMin
      ? [
          {
            type: TariffDimensionType.PARKING_TIME,
            price: idleRatePerMin * MINUTES_IN_HOUR,
            vat,
            step_size: 60,
          },
        ]
      : [];

    // PARKING_TIME stays out of the min_power element: that element is active
    // only while power is flowing, and parking is by definition when it is not.
    // The dimension itself already scopes it, so it needs no restriction.
    const unrestrictedAll = [...unrestricted, ...parking];

    // With no power floor configured the restriction adds nothing, so keep the
    // single-element shape rather than splitting for its own sake.
    if (!minPowerKw) {
      const combined = [...unrestrictedAll, ...time];
      return combined.length
        ? [{ price_components: combined, restrictions: undefined }]
        : [];
    }

    const elements: TariffElement[] = [];

    // An element with no price components is not valid OCPI, so only emit each
    // one when it actually carries a price. A time-only tariff (pricePerKwh 0,
    // pricePerMin set) yields the restricted element alone.
    if (unrestrictedAll.length) {
      elements.push({
        price_components: unrestrictedAll,
        restrictions: undefined,
      });
    }

    if (time.length) {
      elements.push({
        price_components: time,
        restrictions: { min_power: minPowerKw }, // kW, per OCPI
      });
    }

    return elements;
  }

  // TODO make flexible for more complicated tariffs
  //
  // Currently uncalled — flagged rather than deleted. Updated regardless because
  // getTariffElements now emits TIME in a separate restricted element, which
  // would have made the previous elements[0] lookup silently drop the time rate.
  private mapTariffElementToCoreTariff(
    tariffElements: TariffElement[],
  ): Partial<ITariffDto> {
    const priceComponents = tariffElements.flatMap(
      (element) => element.price_components ?? [],
    );
    const pricePerKwh =
      priceComponents.find((pc) => pc.type === TariffDimensionType.ENERGY)
        ?.price ?? 0;
    const pricePerMin =
      (priceComponents.find((pc) => pc.type === TariffDimensionType.TIME)
        ?.price ?? 0) / MINUTES_IN_HOUR;
    const pricePerSession =
      priceComponents.find((pc) => pc.type === TariffDimensionType.FLAT)
        ?.price ?? 0;
    const taxRate = priceComponents.find((pc) => pc.vat)?.vat ?? 0;

    return {
      pricePerKwh,
      pricePerMin,
      pricePerSession,
      taxRate,
    };
  }
}
