import type { Sql } from '@propertyos/db';

/**
 * Money arriving against one of Spike's invoices, and money going back out.
 *
 * Extracted because there are now three ways funds reach an invoice — an
 * operator reading the bank statement, a card payment, a debit order
 * collection — and the rule about what they do to it must be the same rule in
 * all three. A second copy is how one of them starts marking invoices settled
 * for less than they say.
 *
 * The rule, which `recordSubscriptionPayment` has followed since it was
 * written: an invoice is settled when what has arrived covers what it says,
 * and not before. A short payment is recorded as what arrived and leaves the
 * invoice issued, because marking it paid would make the figure an operator
 * trusts — what customers owe — quietly wrong.
 */

export interface SettlementOutcome {
  /** True when this took the invoice to paid. */
  settled: boolean;
  /** Everything received against it, after this. */
  paidMinor: number;
  totalMinor: number;
}

export async function applyFundsToInvoice(
  tx: Sql,
  params: { invoiceId: string; amountMinor: number; reference: string },
): Promise<SettlementOutcome> {
  const [invoice] = await tx<{ total_minor: string; paid_minor: string | null }[]>`
    select total_minor::text, paid_minor::text from subscription_invoices
    where id = ${params.invoiceId}::uuid
    for update
  `;
  const already = Number(invoice?.paid_minor ?? 0);
  const total = Number(invoice?.total_minor ?? 0);
  const paidMinor = already + params.amountMinor;
  const settled = paidMinor >= total;

  await tx`
    update subscription_invoices
       set status = ${settled ? 'paid' : 'issued'},
           paid_on = ${settled ? tx`current_date` : tx`null`},
           paid_minor = ${paidMinor},
           payment_reference = ${params.reference}
           -- payment_recorded_by stays null: no operator recorded this, and
           -- the attempt or collection row says what did.
     where id = ${params.invoiceId}::uuid and status = 'issued'
  `;

  return { settled, paidMinor, totalMinor: total };
}

/**
 * Money leaving again: a disputed debit order, or a reversal.
 *
 * A payer can dispute a debit order and have it reversed by their bank, and
 * when that happens the invoice was never paid. So this is not a credit note
 * or an adjustment — it is the undoing of a settlement that turned out not to
 * have happened, and the invoice goes back to owing exactly what it owed.
 *
 * It refuses to take an invoice below zero received, because that would mean
 * reversing money that never arrived, and the arithmetic afterwards would be
 * nobody's idea of what the customer owes.
 */
export async function reverseFundsOnInvoice(
  tx: Sql,
  params: { invoiceId: string; amountMinor: number; reference: string },
): Promise<SettlementOutcome> {
  const [invoice] = await tx<{ total_minor: string; paid_minor: string | null }[]>`
    select total_minor::text, paid_minor::text from subscription_invoices
    where id = ${params.invoiceId}::uuid
    for update
  `;
  const already = Number(invoice?.paid_minor ?? 0);
  const total = Number(invoice?.total_minor ?? 0);
  const paidMinor = Math.max(0, already - params.amountMinor);
  const settled = paidMinor >= total && total > 0;

  await tx`
    update subscription_invoices
       set status = ${settled ? 'paid' : 'issued'},
           paid_on = ${settled ? tx`paid_on` : tx`null`},
           paid_minor = ${paidMinor === 0 ? null : paidMinor},
           payment_reference = ${params.reference}
     where id = ${params.invoiceId}::uuid and status in ('issued', 'paid')
  `;

  return { settled, paidMinor, totalMinor: total };
}
