// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

export const EVSE_COMPONENT = 'EVSE';
export const CONNECTOR_COMPONENT = 'Connector';
export const AUTH_CONTROLLER_COMPONENT = 'AuthCtrlr';
export const TOKEN_READER_COMPONENT = 'TokenReader';
export const AVAILABILITY_STATE_VARIABLE = 'AvailabilityState';
export const UNKNOWN_ID = 'UNKNOWN';
export const NOT_APPLICABLE = 'N/A';
export const MINUTES_IN_HOUR = 60;
export const CREATE = 'create';
export const UPDATE = 'update';
export const COMMAND_RESPONSE_URL_CACHE_NAMESPACE = 'commands';
export const TOKEN_ID_TO_AUTH_REF_CACHE_NAMESPACE = 'tokenIdToAuthRef';
/**
 * Used to replace response url in cache so that the timeout handler knows the command
 * was resolved instead of timed out and doesn't attempt to send a command result.
 */
export const COMMAND_RESPONSE_URL_CACHE_RESOLVED = 'resolved';
/**
 * Added to COMMANDS_TIMEOUT when setting the resolved-marker's cache TTL so it
 * outlives the onChange() fallback window in CommandExecutor (util/CommandExecutor.ts),
 * which waits the same COMMANDS_TIMEOUT duration. Without this margin, a fast-resolving
 * command's cache entry can expire right as the fallback checks it, producing a false TIMEOUT.
 */
export const COMMAND_RESOLVED_CACHE_TTL_BUFFER_SECONDS = 30;

/**
 * Session energy (kWh) that must be delivered before TIME and PARKING_TIME
 * become billable. A charger can latch and report Charging without delivering
 * any power; billing wall-clock from that moment charges the driver for a
 * warm-up they did not consume, and for a faulty charger, for nothing at all.
 *
 * Only meaningful for tariffs with a pricePerMin — an energy-only tariff
 * already self-heals, since zero energy costs zero.
 *
 * Shares its name with the gateway's own gate so one operational value covers
 * both the CPO and the direct-OCPP paths. Set to 0 to disable.
 *
 * Default 0.02: production meter registers step in 10 Wh and the smallest
 * observed first positive delta was 50 Wh, so 0.02 clears real charging with
 * margin while still excluding a register that never moved.
 */
export const DEFAULT_BILLING_ENERGY_THRESHOLD_KWH = 0.02;

/**
 * Power floor (kW) below which a TIME tariff element is inactive, published to
 * roaming partners as TariffRestrictions.min_power.
 *
 * This is the OCPI-native expression of the same rule the CDR enforces: per
 * spec, "When the EV is charging with more than, or equal to, the defined
 * amount of power, this TariffElement is/becomes active. If the charging power
 * is or becomes lower, this TariffElement is not or no longer valid and becomes
 * inactive." Publishing it means a partner computing their own driver's price
 * from our tariff reaches the same answer we do, instead of billing time we
 * never billed them for.
 *
 * Default 0.1 kW: real charging on the slowest AC point is an order of
 * magnitude above it, while a latched-but-dead charger and any auxiliary draw
 * sit well below.
 */
export const DEFAULT_BILLING_MIN_POWER_KW = 0.1;

/**
 * Idle (parking) pricing for roaming CDRs, per station.
 *
 * DUPLICATION WARNING. The authoritative idle rate lives on the gateway, as
 * citrine_extended_location.idle_rate / idle_buffer_time_in_minute — location 3
 * carries 0.50/min behind a 30 minute buffer. The core Tariff model has no idle
 * column and the OCPI layer owns no tables of its own, so with the vendored
 * citrineos-core fork deliberately left untouched there is nowhere else to put
 * this. Keep the two in sync by hand; if they drift, a roaming driver and one of
 * our own app users at the same charger get different idle bills.
 *
 * Idle here means post-charging hogging only — the span after the last meter
 * value that advanced, minus the buffer. It deliberately excludes the warm-up
 * and any mid-session stall, which are the charger's fault and must stay free.
 *
 * Configured as JSON keyed by station id, read straight from the environment.
 * These four BILLING_* vars deliberately sit outside the zod OcpiConfig schema:
 * the mappers that need them are static and have no config handle, and the
 * threshold has to carry the same name in the gateway so one operational value
 * covers both repos. What the schema would have given for free — a loud failure
 * on a malformed value — is done by hand in readBillingNumber below, because a
 * mistyped idle rate that silently means "no charge" is indistinguishable from
 * a deliberate zero.
 *   BILLING_IDLE_RATE_PER_MIN='{"55102-002":0.5}'
 *   BILLING_IDLE_BUFFER_MINUTES='{"55102-002":30}'
 *
 * Absent or zero rate = no parking charge, which is today's behaviour.
 */
export const DEFAULT_BILLING_IDLE_BUFFER_MINUTES = 30;

function parseStationMap(
  name: string,
  raw: string | undefined,
): Record<string, number> {
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`${name}="${raw}" is not valid JSON; ignoring it entirely`);
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(
      `${name} must be a JSON object keyed by station id; ignoring it`,
    );
    return {};
  }

  const entries: Array<readonly [string, number]> = [];
  for (const [station, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      entries.push([station, numeric] as const);
      continue;
    }
    console.warn(
      `${name} entry for station ${station} is not a non-negative number; ignoring that station`,
    );
  }

  return Object.fromEntries(entries);
}

export function getBillingIdleRatePerMin(stationId?: string | null): number {
  if (!stationId) return 0;
  return (
    parseStationMap(
      'BILLING_IDLE_RATE_PER_MIN',
      process.env.BILLING_IDLE_RATE_PER_MIN,
    )[stationId] ?? 0
  );
}

export function getBillingIdleBufferMinutes(stationId?: string | null): number {
  if (!stationId) return DEFAULT_BILLING_IDLE_BUFFER_MINUTES;
  const configured = parseStationMap(
    'BILLING_IDLE_BUFFER_MINUTES',
    process.env.BILLING_IDLE_BUFFER_MINUTES,
  )[stationId];
  return configured ?? DEFAULT_BILLING_IDLE_BUFFER_MINUTES;
}

/**
 * One non-negative number from the environment, or the default — loudly.
 *
 * Absent means "not configured", which is the default and silent. Present but
 * unusable means an operator typo on a value that decides what a partner is
 * invoiced, so it is warned about rather than swallowed.
 */
function readBillingNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;

  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;

  console.warn(
    `${name}="${raw}" is not a non-negative number; falling back to ${fallback}`,
  );
  return fallback;
}

export function getBillingMinPowerKw(): number {
  return readBillingNumber(
    'BILLING_MIN_POWER_KW',
    DEFAULT_BILLING_MIN_POWER_KW,
  );
}

export function getBillingEnergyThresholdKwh(): number {
  return readBillingNumber(
    'BILLING_ENERGY_THRESHOLD_KWH',
    DEFAULT_BILLING_ENERGY_THRESHOLD_KWH,
  );
}
