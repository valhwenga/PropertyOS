import {
  Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import {
  billerForInvoice, customerSubscriptionInvoices, formatMinor, formatMoney, listPlans,
} from '@propertyos/domain';
import Link from 'next/link';
import { BackLink } from '@/components/back-link';
import { SectionIcon } from '@/components/icons';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Your Spike subscription' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { tone: StatusTone; glyph: string; label: string }> = {
  issued: { tone: 'info', glyph: '◐', label: 'Due' },
  paid: { tone: 'positive', glyph: '●', label: 'Paid' },
  void: { tone: 'neutral', glyph: '■', label: 'Withdrawn' },
};

/**
 * What the landlord pays Spike, from the landlord's side.
 *
 * Deliberately not a copy of the operator console's view. An operator needs
 * usage against allowance and what the account is worth; a customer needs to
 * know what they are on, what they have been charged, what is still owing, and
 * where to pay it.
 */
export default async function SubscriptionPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);

  const [invoices, biller, plans] = await readAs(context.viewer, async (tx) => [
    await customerSubscriptionInvoices(tx, context.organisationId),
    await billerForInvoice(tx),
    await listPlans(tx),
  ] as const);

  const latest = invoices.find((i) => i.status !== 'void') ?? null;
  const plan = plans.find((p) => p.key === latest?.planKey) ?? null;
  const owing = invoices
    .filter((i) => i.status === 'issued')
    .reduce((sum, i) => sum + i.totalMinor - (i.paidMinor ?? 0), 0);
  const overdue = invoices.filter((i) => i.overdue);

  return (
    <div className="space-y-6">
      <BackLink href={`/app/${org}/settings`} label="Settings" />

      <PageHeader
        title="Your Spike subscription"
        description="What you are on, what you have been charged, and what is still owing."
      />

      {invoices.length === 0 ? (
        <EmptyState
          title="You have not been invoiced yet"
          description="When Spike bills your subscription, the invoice appears here with every line on it."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Your plan</p>
              <p className="mt-1 text-2xl font-semibold capitalize">
                {latest?.planName ?? '—'}
              </p>
              {plan ? (
                <p className="mt-1 text-xs text-ink-400">
                  {plan.includedUnits} units included ·{' '}
                  {formatMoney(plan.additionalUnitPriceMinor, plan.currencyCode)} per unit over
                </p>
              ) : null}
            </Card>
            <Card className={owing > 0 ? 'border-info-700/30 p-4' : 'p-4'}>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Owing</p>
              <p className="tabular mt-1 text-2xl font-semibold">
                {formatMoney(owing, latest?.currencyCode ?? 'ZAR')}
              </p>
              <p className="mt-1 text-xs text-ink-400">
                {owing === 0
                  ? 'nothing outstanding'
                  : overdue.length > 0
                    ? `${overdue.length} past its due date`
                    : 'not yet due'}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Last invoice
              </p>
              <p className="tabular mt-1 text-2xl font-semibold">
                {latest ? formatMoney(latest.totalMinor, latest.currencyCode) : '—'}
              </p>
              {latest ? (
                <p className="mt-1 text-xs text-ink-400">
                  {latest.invoiceNumber} · {formatDate(latest.periodStart)}
                </p>
              ) : null}
            </Card>
          </div>

          {biller?.legalName ? (
            <Card className="p-4 text-sm text-ink-700">
              <p className="font-medium text-ink-900">Billed to you by</p>
              <p className="mt-1 whitespace-pre-line">{biller.legalName}</p>
              {biller.address ? (
                <p className="whitespace-pre-line text-ink-500">{biller.address}</p>
              ) : null}
              <p className="mt-1 text-ink-500">
                {biller.vatNumber
                  ? `VAT registration ${biller.vatNumber}`
                  : 'Not a registered VAT vendor, so no tax is charged on these invoices.'}
              </p>
              {biller.bankDetails ? (
                <p className="mt-2 whitespace-pre-line">
                  <span className="font-medium text-ink-900">Pay into</span>
                  {'\n'}{biller.bankDetails}
                  {'\n'}
                  <span className="text-ink-500">
                    Quote the invoice number as the reference.
                  </span>
                </p>
              ) : null}
            </Card>
          ) : null}

          <section aria-labelledby="invoices" className="space-y-3">
            <h2 id="invoices" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
              Your invoices
            </h2>
            <div className="space-y-3">
              {invoices.map((i) => (
                <Card key={i.id} className="p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-ink-900">
                        <span className="tabular">{i.invoiceNumber}</span>
                        <span className="ml-2 font-normal text-ink-500">
                          {i.supplierVatNumber ? 'Tax invoice' : 'Invoice'}
                        </span>
                      </p>
                      <p className="text-xs text-ink-500">
                        {formatDate(i.periodStart)} to {formatDate(i.periodEnd)} · issued{' '}
                        {formatDate(i.issueDate)} · due {formatDate(i.dueDate)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge
                        tone={STATUS[i.status]!.tone}
                        glyph={STATUS[i.status]!.glyph}
                      >
                        {STATUS[i.status]!.label}
                      </StatusBadge>
                      <p className="tabular text-lg font-semibold">
                        {formatMoney(i.totalMinor, i.currencyCode)}
                      </p>
                      <Link
                        href={`/app/${org}/settings/subscription/${i.id}/invoice.pdf`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm text-ink-700 hover:border-spike-300"
                        aria-label={`Download ${i.invoiceNumber} as a PDF`}
                      >
                        <SectionIcon name="download" className="h-4 w-4" />
                        PDF
                      </Link>
                    </div>
                  </div>

                  <DataTable
                    caption={`What ${i.invoiceNumber} charged`}
                    head={
                      <tr>
                        <Th>What for</Th><Th numeric>Quantity</Th>
                        <Th numeric>Each</Th><Th numeric>Amount</Th>
                      </tr>
                    }
                  >
                    {i.lines.map((l) => (
                      <tr key={l.lineNo}>
                        <Td>{l.description}</Td>
                        <Td numeric className="tabular">{l.quantity}</Td>
                        <Td numeric className="tabular">
                          {formatMinor(l.unitPriceMinor, i.currencyCode)}
                        </Td>
                        <Td numeric className="tabular">
                          {formatMinor(l.amountMinor, i.currencyCode)}
                        </Td>
                      </tr>
                    ))}
                    <tr className="border-t border-ink-200">
                      <Td>Net</Td><Td numeric>{''}</Td><Td numeric>{''}</Td>
                      <Td numeric className="tabular">
                        {formatMinor(i.subtotalMinor, i.currencyCode)}
                      </Td>
                    </tr>
                    <tr>
                      <Td>
                        {i.vatMinor === 0
                          ? 'VAT — none charged'
                          : `VAT at ${(i.vatRateBp / 100).toFixed(0)}%`}
                      </Td>
                      <Td numeric>{''}</Td><Td numeric>{''}</Td>
                      <Td numeric className="tabular">
                        {formatMinor(i.vatMinor, i.currencyCode)}
                      </Td>
                    </tr>
                    <tr className="border-t border-ink-200 font-semibold">
                      <Td>Total</Td><Td numeric>{''}</Td><Td numeric>{''}</Td>
                      <Td numeric className="tabular">
                        {formatMinor(i.totalMinor, i.currencyCode)}
                      </Td>
                    </tr>
                  </DataTable>

                  {i.status === 'issued' && i.paidMinor ? (
                    <p className="mt-2 text-xs text-caution-700">
                      {formatMoney(i.paidMinor, i.currencyCode)} received against this invoice;
                      the balance is still owing.
                    </p>
                  ) : null}
                  {i.status === 'paid' ? (
                    <p className="mt-2 text-xs text-ink-500">
                      Paid {i.paidOn ? formatDate(i.paidOn) : ''}
                      {i.paymentReference ? ` · ${i.paymentReference}` : ''}
                    </p>
                  ) : null}
                  {i.voidReason ? (
                    <p className="mt-2 text-xs text-ink-500">
                      Withdrawn by Spike — {i.voidReason}
                    </p>
                  ) : null}
                </Card>
              ))}
            </div>
          </section>
        </>
      )}

      <p className="text-xs text-ink-400">
        Spike records payments by hand from its own bank statement, so an invoice can show as
        owing for a day or two after you have paid it. There is no debit order and nothing
        here takes money from you.
      </p>
    </div>
  );
}
