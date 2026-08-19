// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { CommandResponseSchema, CommandResponseType } from './CommandResponse';
import { CommandResultSchema, CommandResultType } from './CommandResult';

/**
 * OCPI 2.2.1 gives `message` cardinality `*` on both CommandResponse and
 * CommandResult (mod_commands), so it is a list of DisplayText. Sending a bare
 * object made Gentari's receiver drop our START_SESSION CommandResult on
 * 2026-08-18 while still acking the webhook with status_code 1000.
 */
describe('CommandResult message cardinality', () => {
  const displayText = {
    language: 'en',
    text: 'Charging station start session successful',
  };

  it('accepts a list of DisplayText', () => {
    const parsed = CommandResultSchema.parse({
      result: CommandResultType.ACCEPTED,
      message: [displayText],
    });

    expect(parsed.message).toEqual([displayText]);
  });

  it('rejects a single DisplayText object', () => {
    expect(() =>
      CommandResultSchema.parse({
        result: CommandResultType.ACCEPTED,
        message: displayText,
      }),
    ).toThrow();
  });

  it('leaves message optional', () => {
    expect(
      CommandResultSchema.parse({ result: CommandResultType.FAILED }).message,
    ).toBeUndefined();
  });
});

describe('CommandResponse message cardinality', () => {
  it('accepts a list of DisplayText and rejects a bare object', () => {
    const message = [{ language: 'en', text: 'Accepted' }];

    expect(
      CommandResponseSchema.parse({
        result: CommandResponseType.ACCEPTED,
        timeout: 30,
        message,
      }).message,
    ).toEqual(message);

    expect(() =>
      CommandResponseSchema.parse({
        result: CommandResponseType.ACCEPTED,
        timeout: 30,
        message: message[0],
      }),
    ).toThrow();
  });
});
