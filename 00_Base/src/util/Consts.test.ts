// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_BILLING_ENERGY_THRESHOLD_KWH,
  DEFAULT_BILLING_IDLE_BUFFER_MINUTES,
  DEFAULT_BILLING_MIN_POWER_KW,
  getBillingEnergyThresholdKwh,
  getBillingIdleBufferMinutes,
  getBillingIdleRatePerMin,
  getBillingMinPowerKw,
} from './Consts';

// The idle rate is configured per station here because the core Tariff model
// has no idle column and the OCPI layer owns no tables. It duplicates the
// gateway's citrine_extended_location.idle_rate, so parsing has to fail safe:
// a malformed value must mean "no idle charge", never a wrong charge.
describe('billing idle configuration', () => {
  afterEach(() => {
    delete process.env.BILLING_IDLE_RATE_PER_MIN;
    delete process.env.BILLING_IDLE_BUFFER_MINUTES;
  });

  describe('getBillingIdleRatePerMin', () => {
    it('is zero when nothing is configured', () => {
      expect(getBillingIdleRatePerMin('55102-002')).toBe(0);
    });

    it('reads the rate for a configured station', () => {
      process.env.BILLING_IDLE_RATE_PER_MIN = '{"55102-002":0.5}';

      expect(getBillingIdleRatePerMin('55102-002')).toBe(0.5);
    });

    it('is zero for a station absent from the map', () => {
      process.env.BILLING_IDLE_RATE_PER_MIN = '{"55102-002":0.5}';

      expect(getBillingIdleRatePerMin('55100-003')).toBe(0);
    });

    it('is zero when the station is unknown', () => {
      process.env.BILLING_IDLE_RATE_PER_MIN = '{"55102-002":0.5}';

      expect(getBillingIdleRatePerMin(undefined)).toBe(0);
    });

    it('fails safe on malformed JSON rather than guessing', () => {
      process.env.BILLING_IDLE_RATE_PER_MIN = 'not json';

      expect(getBillingIdleRatePerMin('55102-002')).toBe(0);
    });

    it('ignores negative and non-numeric rates', () => {
      process.env.BILLING_IDLE_RATE_PER_MIN =
        '{"a":-1,"b":"abc","55102-002":0.5}';

      expect(getBillingIdleRatePerMin('a')).toBe(0);
      expect(getBillingIdleRatePerMin('b')).toBe(0);
      expect(getBillingIdleRatePerMin('55102-002')).toBe(0.5);
    });
  });

  describe('getBillingIdleBufferMinutes', () => {
    it('defaults to the standard free window', () => {
      expect(getBillingIdleBufferMinutes('55102-002')).toBe(
        DEFAULT_BILLING_IDLE_BUFFER_MINUTES,
      );
    });

    it('reads a per-station override', () => {
      process.env.BILLING_IDLE_BUFFER_MINUTES = '{"55102-002":15}';

      expect(getBillingIdleBufferMinutes('55102-002')).toBe(15);
    });

    it('allows an explicit zero buffer', () => {
      process.env.BILLING_IDLE_BUFFER_MINUTES = '{"55102-002":0}';

      expect(getBillingIdleBufferMinutes('55102-002')).toBe(0);
    });

    it('falls back to the default for an unconfigured station', () => {
      process.env.BILLING_IDLE_BUFFER_MINUTES = '{"55102-002":15}';

      expect(getBillingIdleBufferMinutes('55100-003')).toBe(
        DEFAULT_BILLING_IDLE_BUFFER_MINUTES,
      );
    });
  });
});

// A mistyped billing var used to resolve silently to its default: a malformed
// BILLING_IDLE_RATE_PER_MIN meant "no idle charge" and nobody learned, and
// BILLING_MIN_POWER_KW=abc quietly became 0.1 kW. These values decide what a
// roaming partner is invoiced, so a malformed one is an operator error that has
// to be audible.
describe('billing configuration is validated, not silently defaulted', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

  afterEach(() => {
    delete process.env.BILLING_ENERGY_THRESHOLD_KWH;
    delete process.env.BILLING_MIN_POWER_KW;
    delete process.env.BILLING_IDLE_RATE_PER_MIN;
    warn.mockClear();
  });

  afterAll(() => warn.mockRestore());

  it('warns and falls back when the energy threshold is not a number', () => {
    process.env.BILLING_ENERGY_THRESHOLD_KWH = 'abc';

    expect(getBillingEnergyThresholdKwh()).toBe(
      DEFAULT_BILLING_ENERGY_THRESHOLD_KWH,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('BILLING_ENERGY_THRESHOLD_KWH'),
    );
  });

  it('warns and falls back when the power floor is negative', () => {
    process.env.BILLING_MIN_POWER_KW = '-1';

    expect(getBillingMinPowerKw()).toBe(DEFAULT_BILLING_MIN_POWER_KW);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('BILLING_MIN_POWER_KW'),
    );
  });

  it('warns when a station map is not parseable JSON', () => {
    process.env.BILLING_IDLE_RATE_PER_MIN = '{55102-002: 0.5}';

    expect(getBillingIdleRatePerMin('55102-002')).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('BILLING_IDLE_RATE_PER_MIN'),
    );
  });

  it('warns when a station map entry is not a usable number', () => {
    process.env.BILLING_IDLE_RATE_PER_MIN = '{"55102-002":"free"}';

    expect(getBillingIdleRatePerMin('55102-002')).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('55102-002'),
    );
  });

  it('stays silent when every value is well formed', () => {
    process.env.BILLING_ENERGY_THRESHOLD_KWH = '0.02';
    process.env.BILLING_MIN_POWER_KW = '0.1';
    process.env.BILLING_IDLE_RATE_PER_MIN = '{"55102-002":0.5}';

    getBillingEnergyThresholdKwh();
    getBillingMinPowerKw();
    getBillingIdleRatePerMin('55102-002');

    expect(warn).not.toHaveBeenCalled();
  });
});
