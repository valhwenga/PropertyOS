import type { Sql } from '@propertyos/db';
import { notFound } from './errors';
import type { Minor } from './money';

export interface StatementLine {
  entryDate: string;
  dueDate: string;
  kind: 'charge' | 'allocation';
  type: string;
  reference: string;
  description: string;
  debitMinor: Minor;
  creditMinor: Minor;
  /** Receivable after this line, in document order. */
  runningBalanceMinor: Minor;
}

export interface Statement {
  leaseId: string;
  leaseReference: string;
  organisationId: string;
  currencyCode: string;
  /** The statement is reproducible: the same cut off always yields the same lines. */
  cutOff: string;
  openingBalanceMinor: Minor;
  openingBalanceSource: 'prior_activity' | 'no_prior_activity';
  lines: StatementLine[];
  closingReceivableMinor: Minor;
  /** Overpayment held as credit. Reported separately from the receivable. */
  unappliedCreditMinor: Minor;
  /**
   * Deposit held. A separate liability: it does NOT reduce the receivable until
   * an approved, lawful transfer is posted.
   */
  depositHeldMinor: Minor;
  /** Submitted but unverified; carries no accounting effect. */
  pendingEvidence: Array<{ claimedAmountMinor: Minor; claimedPaidAt: string; status: string }>;
  generatedAt: string;
}

/**
 * Builds a resident statement from posted records only.
 *
 * Every figure traces to a posted charge line or a live allocation. Nothing is
 * read from a cached counter, and nothing is estimated. Two things are shown but
 * deliberately excluded from the receivable:
 *   * the deposit, which is a separate liability;
 *   * uploaded payment evidence, which is unverified until an operator confirms
 *     the funds.
 *
 * The statement runs under the caller's own RLS context, so a resident asking
 * for a lease they do not hold receives "not found" rather than another
 * household's figures.
 */
export async function buildStatement(
  tx: Sql,
  organisationId: string,
  params: { leaseId: string; from?: string; cutOff: string },
): Promise<Statement> {
  const [lease] = await tx<{ id: string; reference: string; currency_code: string }[]>`
    select id, reference, currency_code from leases
    where id = ${params.leaseId}::uuid and organisation_id = ${organisationId}::uuid
  `;
  if (!lease) throw notFound('Lease');

  const from = params.from ?? null;

  // Opening balance = everything posted strictly before the window start.
  const [opening] = await tx<{ opening: string; had_activity: boolean }[]>`
    select
      coalesce(sum(debit_minor - credit_minor), 0)::text as opening,
      count(*) > 0 as had_activity
    from lease_ledger_entries
    where organisation_id = ${organisationId}::uuid
      and lease_id = ${params.leaseId}::uuid
      and (${from}::date is not null and entry_date < ${from}::date)
  `;
  const openingBalance = BigInt(opening?.opening ?? '0');

  const rows = await tx<
    {
      entry_date: string; due_date: string; entry_kind: 'charge' | 'allocation';
      entry_type: string; reference: string; description: string;
      debit_minor: string; credit_minor: string;
    }[]
  >`
    select entry_date::text, due_date::text, entry_kind, entry_type, reference,
           description, debit_minor::text, credit_minor::text
    from lease_ledger_entries
    where organisation_id = ${organisationId}::uuid
      and lease_id = ${params.leaseId}::uuid
      and entry_date <= ${params.cutOff}::date
      and (${from}::date is null or entry_date >= ${from}::date)
    order by entry_date asc, entry_kind asc, reference asc
  `;

  let running = openingBalance;
  const lines: StatementLine[] = rows.map((r) => {
    const debit = BigInt(r.debit_minor);
    const credit = BigInt(r.credit_minor);
    running = running + debit - credit;
    return {
      entryDate: r.entry_date,
      dueDate: r.due_date,
      kind: r.entry_kind,
      type: r.entry_type,
      reference: r.reference,
      description: r.description,
      debitMinor: debit,
      creditMinor: credit,
      runningBalanceMinor: running,
    };
  });

  const [balances] = await tx<{ unapplied: string; deposit: string }[]>`
    select
      coalesce((select sum(unapplied_minor) from receipt_balances
                where lease_id = ${params.leaseId}::uuid), 0)::text as unapplied,
      coalesce((select sum(de.amount_minor)
                from deposit_accounts da
                join deposit_events de on de.deposit_account_id = da.id
                where da.lease_id = ${params.leaseId}::uuid), 0)::text as deposit
  `;

  const evidence = await tx<
    { claimed_amount_minor: string; claimed_paid_at: string; status: string }[]
  >`
    select claimed_amount_minor::text, claimed_paid_at::text, status
    from payment_evidence
    where lease_id = ${params.leaseId}::uuid
      and organisation_id = ${organisationId}::uuid
      and status in ('submitted', 'under_review')
    order by submitted_at desc
  `;

  return {
    leaseId: lease.id,
    leaseReference: lease.reference,
    organisationId,
    currencyCode: lease.currency_code,
    cutOff: params.cutOff,
    openingBalanceMinor: openingBalance,
    openingBalanceSource: opening?.had_activity ? 'prior_activity' : 'no_prior_activity',
    lines,
    closingReceivableMinor: running,
    unappliedCreditMinor: BigInt(balances?.unapplied ?? '0'),
    depositHeldMinor: BigInt(balances?.deposit ?? '0'),
    pendingEvidence: evidence.map((e) => ({
      claimedAmountMinor: BigInt(e.claimed_amount_minor),
      claimedPaidAt: e.claimed_paid_at,
      status: e.status,
    })),
    generatedAt: new Date().toISOString(),
  };
}
