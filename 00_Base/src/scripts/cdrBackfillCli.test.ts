// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadConfirmedTariffs,
  parseBackfillArgs,
  runBackfillCli,
} from './cdrBackfillCli';

describe('cdr backfill CLI', () => {
  it('is a dry run unless --write is passed', () => {
    expect(parseBackfillArgs([])).toEqual({ write: false, help: false });
    expect(parseBackfillArgs(['--write']).write).toBe(true);
  });

  it('reads the confirmed-tariffs file path', () => {
    expect(parseBackfillArgs(['--tariffs', 't.json']).tariffsFile).toBe(
      't.json',
    );
    expect(() => parseBackfillArgs(['--tariffs'])).toThrow(/file path/);
  });

  it('rejects unknown arguments rather than ignoring a typo like --wrtie', () => {
    expect(() => parseBackfillArgs(['--wrtie'])).toThrow(/Unknown argument/);
  });

  it('loads and validates a confirmed-tariffs file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdr-backfill-'));
    const ok = join(dir, 'ok.json');
    writeFileSync(ok, JSON.stringify({ '52': { pricePerKwh: 0.1 } }));
    expect(loadConfirmedTariffs(ok)).toEqual({ '52': { pricePerKwh: 0.1 } });

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ '52': { pricePerMin: 1 } }));
    expect(() => loadConfirmedTariffs(bad)).toThrow(/pricePerKwh/);
    expect(loadConfirmedTariffs(undefined)).toEqual({});
  });

  it('refuses to run without an explicit GraphQL endpoint', async () => {
    await expect(runBackfillCli([], {}, jest.fn())).rejects.toThrow(
      /HASURA_GRAPHQL_ENDPOINT/,
    );
  });
});
