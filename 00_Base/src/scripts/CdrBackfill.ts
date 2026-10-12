// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

import { ITariffDto, ITransactionDto } from '@citrineos/base';
import { ILogObj, Logger } from 'tslog';
import { buildCdrRecordVariables } from '../broadcaster/CdrRecordVariables';
import { OcpiGraphqlClient } from '../graphql/OcpiGraphqlClient';
import {
  GetCdrBackfillCandidatesQueryResult,
  GetCdrBackfillCandidatesQueryVariables,
  GetTariffByKeyQueryResult,
  GetTariffByKeyQueryVariables,
  InsertCdrRecordIfAbsentMutationResult,
  InsertCdrRecordIfAbsentMutationVariables,
} from '../graphql/operations';
import {
  GET_CDR_BACKFILL_CANDIDATES_QUERY,
  INSERT_CDR_RECORD_IF_ABSENT_MUTATION,
} from '../graphql/queries/cdr.queries';
import { GET_TARIFF_BY_KEY_QUERY } from '../graphql/queries/tariff.queries';
import { CdrMapper } from '../mapper/CdrMapper';
import { Cdr } from '../model/Cdr';

/**
 * The prices a human has confirmed applied at session time for one
 * transaction. There is no tariff history, so this is the only source of a
 * session-time price the backfill will ever write.
 */
export interface ConfirmedTariff {
  pricePerKwh: number;
  pricePerMin?: number;
  pricePerSession?: number;
  taxRate?: number;
  /** Defaults to the currency of the transaction's current tariff row. */
  currency?: string;
}

/** Keyed by Transactions.id (the number in the CDR id, e.g. 52 for 00052). */
export type ConfirmedTariffs = Record<string, ConfirmedTariff>;

const PAGE_SIZE = 200;

export const UNCONFIRMED_TARIFF_SOURCE = 'UNCONFIRMED (current tariff)';

export type BackfillStatus =
  | 'WRITTEN' // inserted (write mode, confirmed tariff)
  | 'WOULD_WRITE' // dry run, confirmed tariff
  | 'UNCONFIRMED' // no confirmed tariff: shown with the current tariff, never written
  | 'ALREADY_EXISTS' // a row with this cdrId is already stored
  | 'SKIPPED' // the mapper could not produce a CDR
  | 'FAILED';

export interface BackfillEntry {
  transactionId: number;
  stationId?: string;
  cdrId?: string;
  status: BackfillStatus;
  /** Set only where a price is shown or written: WRITTEN, WOULD_WRITE, UNCONFIRMED. */
  tariffSource?: 'CONFIRMED' | typeof UNCONFIRMED_TARIFF_SOURCE;
  cdr?: Cdr;
  reason?: string;
}

export interface BackfillReport {
  write: boolean;
  entries: BackfillEntry[];
  /** Confirmed tariffs whose transaction is not a missing-CDR candidate. */
  unmatchedConfirmations: string[];
}

export interface BackfillOptions {
  confirmedTariffs: ConfirmedTariffs;
  /** Default false: a dry run that writes nothing. */
  write?: boolean;
}

/**
 * Finds completed roaming transactions that have no CdrRecords row and
 * (optionally) inserts the missing CDR.
 *
 * Safety properties, all load-bearing:
 *  - A CDR is only ever written with a human-confirmed tariff. Without one the
 *    candidate is shown priced with today's tariff, flagged, and never stored.
 *  - Existing rows are never touched (insert is ON CONFLICT DO NOTHING).
 *  - It never sends anything to a partner. It has no OCPI client; the stored
 *    CDR reaches a partner only through a separate, human-approved step.
 */
export class CdrBackfill {
  constructor(
    private readonly logger: Logger<ILogObj>,
    private readonly ocpiGraphqlClient: OcpiGraphqlClient,
    private readonly cdrMapper: CdrMapper,
  ) {}

  async run(options: BackfillOptions): Promise<BackfillReport> {
    const write = options.write ?? false;
    const confirmed = options.confirmedTariffs;
    CdrBackfill.validateConfirmedTariffs(confirmed);

    // Loaded in full before any write: inserting a row removes its transaction
    // from the candidate set, which would shift offset paging mid-run.
    const candidates = await this.loadCandidates();

    const entries: BackfillEntry[] = [];
    for (const transaction of candidates) {
      entries.push(await this.processCandidate(transaction, confirmed, write));
    }

    const candidateIds = new Set(candidates.map((t) => String(t.id)));
    return {
      write,
      entries,
      unmatchedConfirmations: Object.keys(confirmed).filter(
        (id) => !candidateIds.has(id),
      ),
    };
  }

  static validateConfirmedTariffs(confirmed: ConfirmedTariffs): void {
    for (const [id, tariff] of Object.entries(confirmed)) {
      const where = `confirmed tariff for transaction ${id}`;
      if (!/^\d+$/.test(id)) {
        throw new Error(`${where}: key must be a transaction id`);
      }
      const nonNegative = (name: string, value: unknown, required: boolean) => {
        if (value === undefined && !required) return;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new Error(`${where}: ${name} must be a number >= 0`);
        }
      };
      nonNegative('pricePerKwh', tariff?.pricePerKwh, true);
      nonNegative('pricePerMin', tariff?.pricePerMin, false);
      nonNegative('pricePerSession', tariff?.pricePerSession, false);
      if (tariff.taxRate !== undefined) {
        nonNegative('taxRate', tariff.taxRate, false);
        if (tariff.taxRate > 1) {
          throw new Error(
            `${where}: taxRate is a fraction (0.06 for 6%), got ${tariff.taxRate}`,
          );
        }
      }
    }
  }

  private async processCandidate(
    transaction: ITransactionDto,
    confirmed: ConfirmedTariffs,
    write: boolean,
  ): Promise<BackfillEntry> {
    const transactionId = transaction.id!;
    const confirmedTariff = confirmed[String(transactionId)];
    const entry: BackfillEntry = {
      transactionId,
      stationId: transaction.stationId,
      status: 'FAILED',
    };
    const tariffSource = confirmedTariff
      ? 'CONFIRMED'
      : UNCONFIRMED_TARIFF_SOURCE;

    try {
      const tariffOverrides = new Map<string, ITariffDto>();
      if (confirmedTariff) {
        tariffOverrides.set(
          String(transactionId),
          await this.buildTariff(transaction, confirmedTariff),
        );
      }

      const [cdr] = await this.cdrMapper.mapTransactionsToCdrs([transaction], {
        tariffOverrides,
      });
      if (!cdr) {
        return {
          ...entry,
          status: 'SKIPPED',
          reason: 'mapper produced no CDR (missing tariff, location or token)',
        };
      }
      entry.cdr = cdr;
      entry.cdrId = cdr.id;

      if (!confirmedTariff) {
        return {
          ...entry,
          tariffSource,
          status: 'UNCONFIRMED',
          reason: 'no confirmed session-time tariff; not written',
        };
      }
      if (!write) {
        return { ...entry, tariffSource, status: 'WOULD_WRITE' };
      }

      const result = await this.ocpiGraphqlClient.request<
        InsertCdrRecordIfAbsentMutationResult,
        InsertCdrRecordIfAbsentMutationVariables
      >(
        INSERT_CDR_RECORD_IF_ABSENT_MUTATION,
        buildCdrRecordVariables(cdr, transaction),
      );
      if (!result.insert_CdrRecords_one) {
        // A row with this cdrId exists (e.g. unlinked, or written meanwhile);
        // the do-nothing insert left it untouched.
        return {
          ...entry,
          status: 'ALREADY_EXISTS',
          reason:
            'a CdrRecords row with this cdrId already exists; left untouched',
        };
      }
      return { ...entry, tariffSource, status: 'WRITTEN' };
    } catch (error) {
      this.logger.error(
        `Backfill failed for transaction ${transactionId}`,
        error,
      );
      return {
        ...entry,
        status: 'FAILED',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * The tariff to price with: the confirmed prices, identified as the
   * transaction's own tariff. Only identity (id, currency) is borrowed from
   * the current tariff row; no price ever is.
   */
  private async buildTariff(
    transaction: ITransactionDto,
    confirmed: ConfirmedTariff,
  ): Promise<ITariffDto> {
    const id = transaction.tariffId;
    if (id == null) {
      throw new Error('transaction has no tariffId');
    }

    let currency = confirmed.currency;
    if (!currency) {
      const result = await this.ocpiGraphqlClient.request<
        GetTariffByKeyQueryResult,
        GetTariffByKeyQueryVariables
      >(GET_TARIFF_BY_KEY_QUERY, {
        id,
        countryCode: transaction.tenant!.countryCode!,
        partyId: transaction.tenant!.partyId!,
      });
      currency = result.Tariffs[0]?.currency;
    }
    if (!currency) {
      throw new Error(
        `cannot resolve a currency for tariff ${id}; set currency in the confirmed tariff`,
      );
    }

    return {
      id,
      stationId: transaction.stationId,
      currency,
      pricePerKwh: confirmed.pricePerKwh,
      pricePerMin: confirmed.pricePerMin ?? null,
      pricePerSession: confirmed.pricePerSession ?? null,
      taxRate: confirmed.taxRate ?? null,
      tenant: transaction.tenant,
      // Stamped at session start: the tariff as it stood for this session.
      updatedAt: transaction.startTime ?? transaction.createdAt,
    } as unknown as ITariffDto;
  }

  private async loadCandidates(): Promise<ITransactionDto[]> {
    const candidates: ITransactionDto[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.ocpiGraphqlClient.request<
        GetCdrBackfillCandidatesQueryResult,
        GetCdrBackfillCandidatesQueryVariables
      >(GET_CDR_BACKFILL_CANDIDATES_QUERY, {
        offset,
        limit: PAGE_SIZE,
        where: {
          isActive: { _eq: false },
          Authorization: { TenantPartner: { id: { _is_null: false } } },
          // Only the real gaps: no CdrRecords row linked to the transaction.
          _not: { CdrRecord: {} },
        },
      });
      for (const row of page.Transactions) {
        // Checked again here rather than trusting the query alone: a CDR for a
        // still-running or non-roaming session must never be produced.
        if (row.isActive) continue;
        if (!row.authorization?.tenantPartner) continue;
        candidates.push(row as unknown as ITransactionDto);
      }
      if (page.Transactions.length < PAGE_SIZE) break;
    }
    return candidates;
  }
}

/** Human-readable dry-run / result report for the CLI. */
export function formatBackfillReport(report: BackfillReport): string {
  const lines: string[] = [];
  lines.push(
    report.write
      ? 'MODE: WRITE (confirmed candidates are inserted; nothing is sent to any partner)'
      : 'MODE: DRY RUN (nothing is written; nothing is sent to any partner)',
  );
  lines.push(
    `Candidates (completed roaming transactions without a CdrRecords row): ${report.entries.length}`,
  );
  for (const entry of report.entries) {
    lines.push('');
    lines.push(
      `Transaction ${entry.transactionId} @ ${entry.stationId ?? '?'} -> ${entry.cdrId ?? '(no CDR)'}  [${entry.status}]`,
    );
    if (entry.tariffSource) lines.push(`  tariff: ${entry.tariffSource}`);
    if (entry.reason) lines.push(`  note: ${entry.reason}`);
    if (entry.cdr) {
      const cdr = entry.cdr;
      lines.push(
        `  session: ${cdr.start_date_time} -> ${cdr.end_date_time}, ${cdr.total_energy} kWh`,
      );
      const components = (cdr.tariffs ?? []).flatMap((t) =>
        t.elements.flatMap((e) =>
          e.price_components.map((pc) => `${pc.type} ${pc.price}`),
        ),
      );
      lines.push(
        `  priced with: ${components.join(', ') || '(no components)'} ${cdr.currency}`,
      );
      // Every cost line is shown, including parking: that one is priced from
      // the CURRENT per-station idle rate (BILLING_IDLE_RATE_PER_MIN), not from
      // the confirmed tariff, and the approver must see it.
      const money = (
        price?: { excl_vat: number; incl_vat?: number | null } | null,
      ) =>
        price
          ? `${price.excl_vat} excl VAT${price.incl_vat != null ? `, ${price.incl_vat} incl VAT` : ''}`
          : 'none';
      lines.push(
        `  volumes: total_energy ${cdr.total_energy} kWh, total_time ${cdr.total_time} h, total_parking_time ${cdr.total_parking_time ?? 0} h`,
        `  energy cost:  ${money(cdr.total_energy_cost)}`,
        `  time cost:    ${money(cdr.total_time_cost)}`,
        `  fixed cost:   ${money(cdr.total_fixed_cost)}`,
        `  parking cost: ${money(cdr.total_parking_cost)}  (from the current per-station idle rate, not the confirmed tariff)`,
        `  total_cost:   ${money(cdr.total_cost)}`,
      );
    }
  }
  if (report.unmatchedConfirmations.length > 0) {
    lines.push('');
    lines.push(
      `WARNING: confirmed tariffs matched no candidate (wrong id, already has a CDR, or not roaming): ${report.unmatchedConfirmations.join(', ')}`,
    );
  }
  const unconfirmed = report.entries.filter(
    (e) => e.status === 'UNCONFIRMED',
  ).length;
  if (unconfirmed > 0) {
    lines.push('');
    lines.push(
      `${unconfirmed} candidate(s) UNCONFIRMED: priced above with TODAY's tariff for display only and never written. Confirm the session-time tariff per transaction and pass it via --tariffs.`,
    );
  }
  return lines.join('\n');
}
