import Link from 'next/link';
import {
  Card, DataTable, EmptyState, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import {
  formatMinor, formatMoney, listSubscriptionInvoices, minorToMajorInput, openPaymentAttempts,
  platformBillingSettings,
} from '@propertyos/domain';
import { BackLink } from '@/components/back-link';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import {
  BillingSettingsForm, RecordPaymentForm, RunBillingForm, VoidInvoiceForm,
} from './billing-forms';

export const metadata = { title: 'Billing' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { tone: StatusTone; glyph: string; label: string }> = {
  issued: { tone: 'info', glyph: '◐', label: 'Issued' },
  paid: { tone: 'positive', glyph: '●', label: 'Paid' },
  void: { tone: 'neutral', glyph: '■', label: 'Void' },
};

/** The first day of last month, which is the month an operator usually bills. */
function lastMonthStart(today: Date): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 10);
}

export default async function PlatformBillingPage() {
  const viewer = await requireViewer();
  const [settings, invoices, pendingAttempts] = await readAs(viewer, async (tx) => [
    await platformBillingSettings(tx, viewer.authUserId),
    await listSubscriptionInvoices(tx, viewer.authUserId),
    // So that an operator about to record a bank transfer can see that the
    // customer has a card payment in flight. Recording both is how a customer
    // gets credited twice.
    await openPaymentAttempts(tx),
  ] as const);

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const outstanding = invoices
    .filter((i) => i.status === 'issued')
    .reduce((sum, i) => sum + i.totalMinor - (i.paidMinor ?? 0), 0);
  const overdue = invoices.filter((i) => i.overdue);
  const billedThisYear = invoices
    .filter((i) => i.status !== 'void' && i.issueDate.slice(0, 4) === todayIso.slice(0, 4))
    .reduce((sum, i) => sum + i.totalMinor, 0);

  return (
    <div className="space-y-6">
      <BackLink href="/platform" label="Customer organisations" />

      <PageHeader
        title="Billing"
        description="What Spike has charged its customers, and what they still owe."
      />

      <section aria-labelledby="totals" className="space-y-3">
        <h2 id="totals" className="sr-only">Totals</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Outstanding</p>
            <p className="tabular mt-1 text-2xl font-semibold">
              {formatMoney(outstanding, settings.currencyCode)}
            </p>
            <p className="mt-1 text-xs text-ink-400">issued and not yet settled</p>
          </Card>
          <Card className={overdue.length > 0 ? 'border-critical-700/30 p-4' : 'p-4'}>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Overdue</p>
            <p className="tabular mt-1 text-2xl font-semibold">{overdue.length}</p>
            {overdue.length > 0 ? (
              <p className="mt-1 text-xs text-critical-700">
                {formatMoney(
                  overdue.reduce((s, i) => s + i.totalMinor - (i.paidMinor ?? 0), 0),
                  settings.currencyCode,
                )}{' '}
                past its due date
              </p>
            ) : (
              <p className="mt-1 text-xs text-ink-400">nothing past its due date</p>
            )}
          </Card>
          <Card className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Billed in {todayIso.slice(0, 4)}
            </p>
            <p className="tabular mt-1 text-2xl font-semibold">
              {formatMoney(billedThisYear, settings.currencyCode)}
            </p>
            <p className="mt-1 text-xs text-ink-400">voided invoices excluded</p>
          </Card>
        </div>
        <p className="text-xs text-ink-400">
          There is no payment provider and no debit order anywhere in this product. A payment
          is recorded by hand from Spike&rsquo;s own bank statement, which is why
          &ldquo;outstanding&rdquo; means &ldquo;not yet recorded as received&rdquo; rather
          than &ldquo;unpaid&rdquo;. Nothing here chases a customer, suspends an account for
          non-payment, or ends a trial.
        </p>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <BillingSettingsForm
          settings={{
            legalName: settings.legalName,
            address: settings.address,
            email: settings.email,
            vatNumber: settings.vatNumber,
            vatRateBp: settings.vatRateBp,
            bankDetails: settings.bankDetails,
            paymentTermsDays: settings.paymentTermsDays,
          }}
        />
        <RunBillingForm
          defaultPeriodStart={lastMonthStart(today)}
          defaultIssueDate={todayIso}
          readyToIssue={settings.readyToIssue}
          currencyCode={settings.currencyCode}
        />
      </div>

      <section aria-labelledby="invoices" className="space-y-3">
        <h2 id="invoices" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Invoices
        </h2>
        {invoices.length === 0 ? (
          <EmptyState
            title="Nothing has been billed yet"
            description="Bill a month above, and the invoices appear here."
          />
        ) : (
          <DataTable
            caption="Subscription invoices"
            head={
              <tr>
                <Th>Number</Th><Th>Customer</Th><Th>Period</Th><Th>Plan</Th>
                <Th numeric>Units</Th><Th numeric>Net</Th><Th numeric>Tax</Th>
                <Th numeric>Total</Th><Th>Due</Th><Th>State</Th><Th>{''}</Th>
              </tr>
            }
          >
            {invoices.map((i) => {
              const status = STATUS[i.status]!;
              return (
                <tr key={i.id} className="align-top">
                  <Td>
                    <Link
                      href={`/platform/billing/${i.id}/invoice.pdf`}
                      className="tabular font-medium underline decoration-ink-200 underline-offset-2 hover:decoration-ink-900"
                      aria-label={`Download ${i.invoiceNumber} as a PDF`}
                    >
                      {i.invoiceNumber}
                    </Link>
                    {i.supplierVatNumber ? null : (
                      <span className="mt-0.5 block text-xs text-ink-400">no tax shown</span>
                    )}
                  </Td>
                  <Td>{i.organisationName}</Td>
                  <Td className="whitespace-nowrap text-ink-500">
                    {formatDate(i.periodStart)}
                  </Td>
                  <Td className="capitalize text-ink-700">{i.planName}</Td>
                  <Td numeric className="tabular">
                    {i.billableUnits}
                    <span className="text-ink-400"> / {i.includedUnits}</span>
                  </Td>
                  <Td numeric className="tabular">
                    {formatMinor(i.subtotalMinor, i.currencyCode)}
                  </Td>
                  <Td numeric className="tabular text-ink-500">
                    {i.vatMinor === 0 ? '—' : formatMinor(i.vatMinor, i.currencyCode)}
                  </Td>
                  <Td numeric className="tabular font-medium">
                    {formatMinor(i.totalMinor, i.currencyCode)}
                  </Td>
                  <Td className="whitespace-nowrap text-ink-500">
                    {formatDate(i.dueDate)}
                    {i.overdue ? (
                      <span className="mt-0.5 block text-xs text-critical-700">overdue</span>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge tone={status.tone} glyph={status.glyph}>{status.label}</StatusBadge>
                    {i.status === 'paid' && i.paidOn ? (
                      <span className="mt-0.5 block text-xs text-ink-400">
                        {formatDate(i.paidOn)} · {i.paymentReference}
                      </span>
                    ) : null}
                    {i.status === 'issued' && i.paidMinor ? (
                      <span className="mt-0.5 block text-xs text-caution-700">
                        {formatMinor(i.paidMinor, i.currencyCode)} received, short
                      </span>
                    ) : null}
                    {i.voidReason ? (
                      <span className="mt-0.5 block text-xs text-ink-400">{i.voidReason}</span>
                    ) : null}
                    {pendingAttempts.get(i.id) ? (
                      <span className="mt-0.5 block text-xs text-info-700">
                        payment in flight · {pendingAttempts.get(i.id)!.provider} ·{' '}
                        <span className="tabular">{pendingAttempts.get(i.id)!.reference}</span>
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    {i.status === 'issued' ? (
                      <div className="space-y-2">
                        <RecordPaymentForm
                          invoiceId={i.id}
                          invoiceNumber={i.invoiceNumber}
                          amountMajor={minorToMajorInput(i.totalMinor - (i.paidMinor ?? 0), i.currencyCode)}
                          today={todayIso}
                          currencyCode={i.currencyCode}
                        />
                        <VoidInvoiceForm invoiceId={i.id} />
                      </div>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </DataTable>
        )}
      </section>
    </div>
  );
}
