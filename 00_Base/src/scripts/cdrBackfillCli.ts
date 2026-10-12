// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'fs';
import { ILogObj, Logger } from 'tslog';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import { CdrMapper } from '../mapper/CdrMapper';
import { SessionMapper } from '../mapper/SessionMapper';
import { LocationsService } from '../services/LocationsService';
import {
  CdrBackfill,
  ConfirmedTariffs,
  formatBackfillReport,
} from './CdrBackfill';

export const USAGE = `Backfill missing CdrRecords rows (dry run by default).

Usage:
  npm run backfill-cdrs -- [--tariffs <file.json>] [--write]

Environment:
  HASURA_GRAPHQL_ENDPOINT   required, e.g. https://hasura.example/v1/graphql
  HASURA_ADMIN_SECRET       sent as x-hasura-admin-secret

Options:
  --tariffs <file>   JSON object mapping Transactions.id to the human-confirmed
                     session-time tariff:
                       { "52": { "pricePerKwh": 0.10, "pricePerMin": 0,
                                 "pricePerSession": 0, "taxRate": 0,
                                 "currency": "MYR" } }
  --write            Insert the CDRs that have a confirmed tariff. Without it,
                     nothing is written.

Candidates without a confirmed tariff are shown priced with TODAY's tariff,
flagged UNCONFIRMED, and are never written. Nothing is ever sent to a partner.`;

export interface BackfillCliArgs {
  tariffsFile?: string;
  write: boolean;
  help: boolean;
}

export function parseBackfillArgs(argv: string[]): BackfillCliArgs {
  const args: BackfillCliArgs = { write: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') {
      args.write = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--tariffs') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) {
        throw new Error('--tariffs requires a file path');
      }
      args.tariffsFile = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function loadConfirmedTariffs(
  file: string | undefined,
): ConfirmedTariffs {
  if (!file) return {};
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file}: expected a JSON object keyed by transaction id`);
  }
  CdrBackfill.validateConfirmedTariffs(parsed);
  return parsed;
}

export async function runBackfillCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = console.log,
): Promise<number> {
  const args = parseBackfillArgs(argv);
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const endpoint = env.HASURA_GRAPHQL_ENDPOINT;
  if (!endpoint) {
    throw new Error('HASURA_GRAPHQL_ENDPOINT is required');
  }
  const confirmedTariffs = loadConfirmedTariffs(args.tariffsFile);

  const logger = new Logger<ILogObj>({ name: 'cdr-backfill', minLevel: 4 });
  const client = new OcpiGraphqlClient(
    endpoint,
    env.HASURA_ADMIN_SECRET
      ? { 'x-hasura-admin-secret': env.HASURA_ADMIN_SECRET }
      : undefined,
  );
  const locations = new LocationsService(logger, client);
  const mapper = new CdrMapper(
    logger,
    locations,
    client,
    new SessionMapper(logger, locations, client),
  );

  log(`Target: ${endpoint}`);
  const report = await new CdrBackfill(logger, client, mapper).run({
    confirmedTariffs,
    write: args.write,
  });
  log(formatBackfillReport(report));
  return report.entries.some((e) => e.status === 'FAILED') ? 1 : 0;
}
