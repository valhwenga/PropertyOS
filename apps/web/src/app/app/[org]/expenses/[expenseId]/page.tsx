import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import {
  formatMinor, formatMoney, getExpense, hasPermission, listVendors,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadInvoiceChoices, loadPropertyChoices } from '@/lib/operations-queries';
import {
  ApproveExpenseForm, EditDraftForm, PayExpenseForm, VoidExpenseForm,
} from '../expense-forms';

export const metadata = { title: 'Expense' };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, StatusTone> = {
  draft: 'caution', posted: 'info', paid: 'positive', void: 'neutral', approved: 'info',
};

/** What each state means for the books, in words rather than a badge alone. */
const STATUS_MEANING: Record<string, string> = {
  draft: 'Recorded but not in anyone\'s accounts. Nothing has been posted.',
  posted: 'Approved. The property carries the cost and the supplier is owed it. '
    + 'No money has left the bank.',
  paid: 'Approved and paid. The cost is in the result and the money has left the bank.',
  void: 'Voided. Anything it posted has been reversed, and both entries remain in the ledger.',
};

/**
 * One cost: what it was, what it did to the books, and what can still be done.
 *
 * The page leads with what the current state MEANS, because "posted" and "paid"
 * look like synonyms and are not: one says the property carries the cost, the
 * other says the bank is lighter. Reporting treats them differently and so
 * must the person reading this.
 */
export default async function ExpensePage({
  params,
}: {
  params: Promise<{ org: string; expenseId: string }>;
}) {
  const { org, expenseId } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => {
    const expense = await getExpense(tx, context.organisationId, expenseId);
    if (!expense) return undefined;
    return {
      expense,
      properties: await loadPropertyChoices(tx, context.organisationId),
      vendors: await listVendors(tx, context.organisationId),
      invoices: await loadInvoiceChoices(tx, context.organisationId),
      canRecord: await hasPermission(tx, context.organisationId, 'expense.record'),
      canApprove: await hasPermission(tx, context.organisationId, 'expense.approve'),
    };
  });
  if (!data) notFound();

  const { expense, properties, vendors, invoices, canRecord, canApprove } = data;
  const today = new Date().toISOString().slice(0, 10);
  const amountLabel = formatMoney(expense.amountMinor, expense.currencyCode);

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/expenses`} className="text-sm text-spike-600 hover:underline">
        ← Expenses
      </Link>

      <PageHeader
        title={expense.description}
        description={
          `${formatDate(expense.expenseDate, context.timeZone)}`
          + `${expense.propertyName ? ` · ${expense.propertyName}` : ''}`
          + `${expense.vendorName ? ` · ${expense.vendorName}` : ''}`
        }
      />

      <Card className="p-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Amount</dt>
            <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
              <Money minor={expense.amountMinor} currency={expense.currencyCode} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Category</dt>
            <dd className="mt-1 text-sm capitalize text-ink-900">
              {expense.category.replace(/_/g, ' ')}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Kind of cost
            </dt>
            <dd className="mt-1 text-sm text-ink-900">{expense.costClassLabel}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Invoice</dt>
            <dd className="mt-1 text-sm text-ink-900">
              {expense.invoiceReference ?? '—'}
              {expense.invoiceDocumentId ? (
                <Link
                  href={`/app/${org}/documents/${expense.invoiceDocumentId}`}
                  className="ml-1.5 text-xs font-medium text-spike-600 hover:underline"
                >
                  Open →
                </Link>
              ) : null}
            </dd>
          </div>
        </dl>

        <div className="mt-4 border-t border-ink-100 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={STATUS_TONE[expense.status] ?? 'neutral'}>
              {expense.status}
            </StatusBadge>
            {expense.createdByName ? (
              <span className="text-xs text-ink-500">
                recorded by {expense.createdByName} on{' '}
                {formatDate(expense.createdAt, context.timeZone)}
              </span>
            ) : null}
            {expense.approvedByName && expense.approvedAt ? (
              <span className="text-xs text-ink-500">
                approved by {expense.approvedByName} on{' '}
                {formatDate(expense.approvedAt, context.timeZone)}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-ink-700">{STATUS_MEANING[expense.status]}</p>
        </div>
      </Card>

      {/* ------------------------------------------------------- what is next */}

      {expense.status === 'draft' ? (
        <div className="space-y-3">
          {canRecord ? (
            <EditDraftForm
              org={org} expenseId={expenseId} today={today}
              properties={properties.map((p) => ({ id: p.id, label: `${p.name} (${p.code})` }))}
              vendors={vendors.map((v) => ({ id: v.id, label: v.name }))}
              invoices={invoices.map((d) => ({
                id: d.id, label: `${d.title} — ${formatDate(d.uploaded_at, context.timeZone)}`,
              }))}
              expense={{
                propertyId: expense.propertyId,
                vendorId: expense.vendorId,
                category: expense.category,
                costClass: expense.costClass,
                description: expense.description,
                amountMajor: formatMinor(expense.amountMinor, expense.currencyCode)
                  .replace(/,/g, ''),
                expenseDate: expense.expenseDate,
                invoiceReference: expense.invoiceReference,
                invoiceDocumentId: expense.invoiceDocumentId,
              }}
            />
          ) : null}
          {canApprove ? (
            <ApproveExpenseForm
              org={org} expenseId={expenseId} amountLabel={amountLabel} today={today}
            />
          ) : (
            <Card className="p-4">
              <p className="text-sm text-ink-700">
                You recorded this but cannot approve it. Posting a cost to the books needs the
                expense approval permission, which is held separately.
              </p>
            </Card>
          )}
          {canApprove ? <VoidExpenseForm org={org} expenseId={expenseId} today={today} /> : null}
        </div>
      ) : expense.status === 'posted' ? (
        <div className="space-y-3">
          {canApprove ? (
            <>
              <PayExpenseForm
                org={org} expenseId={expenseId} amountLabel={amountLabel} today={today}
              />
              <VoidExpenseForm org={org} expenseId={expenseId} today={today} />
            </>
          ) : (
            <Card className="p-4">
              <p className="text-sm text-ink-700">
                Recording the payment needs the expense approval permission.
              </p>
            </Card>
          )}
        </div>
      ) : expense.status === 'paid' ? (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            This cost is settled. It cannot be voided: the money did leave the account, and
            saying otherwise would misstate the bank. A supplier refund or credit note is
            recorded as what it actually is.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
