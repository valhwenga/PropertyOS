import Link from 'next/link';
import {
  DataTable, Disclosure, EmptyState, Money, PageHeader, Panel, PermissionState,
  StatusBadge, Tabs, Td, Th, buttonClass,
} from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import {
  formatMinor, getInvoiceMessageTemplate, hasPermission, latestInvoicedMonth,
  listInvoicesForSending, type DeliveryState,
} from '@propertyos/domain';
import { resolveEmailAdapter } from '@propertyos/integrations';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { MarkReadyForm, RetryForm, SendReadyForm, WithdrawForm } from './invoice-forms';

export const metadata = { title: 'Sending invoices' };
export const dynamic = 'force-dynamic';

/**
 * The month's invoices, and whether the people who owe them have been told.
 *
 * Deliberately a separate screen from the billing run that produced them.
 * Posting is an accounting act and sending is a communication; running them
 * together is how a landlord discovers they have emailed a figure they were
 * still checking.
 */

const STATE: Record<DeliveryState, { tone: StatusTone; label: string; detail: string }> = {
  not_ready: {
    tone: 'neutral', label: 'Not ready',
    detail: 'Nobody has said this one should go out.',
  },
  ready: {
    tone: 'info', label: 'Ready to send',
    detail: 'Waiting for somebody to send it. Nothing has been sent.',
  },
  queued: {
    tone: 'caution', label: 'Queued',
    detail: 'Handed to the worker. Not yet delivered.',
  },
  sent: {
    tone: 'positive', label: 'Sent',
    detail: 'The provider accepted it.',
  },
  undelivered: {
    tone: 'critical', label: 'Not delivered',
    detail: 'The attempt finished and the message did not go.',
  },
  suppressed: {
    tone: 'caution', label: 'Nobody to send to',
    detail: 'No email address on file for this resident.',
  },
};

/**
 * The first sentence of an outcome, with the rest kept for the tooltip.
 *
 * The sink's reason is a paragraph of configuration advice, which is the right
 * thing to say once and the wrong thing to repeat beside every row.
 */
function shortOutcome(detail: string): { short: string; full: string } {
  const [first] = detail.split(/(?<=\.)\s+/);
  return { short: first ?? detail, full: detail };
}

/** Month boundaries for a yyyy-mm, or the current month when absent. */
function monthBounds(period: string | undefined): { start: string; end: string; label: string } {
  const now = new Date();
  const match = /^(\d{4})-(\d{2})$/.exec(period ?? '');
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const month = match ? Number(match[2]) : now.getUTCMonth() + 1;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    label: start.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

export default async function SendInvoicesPage({
  params, searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ period?: string; state?: string }>;
}) {
  const { org } = await params;
  const { period, state } = await searchParams;
  const context = await requireOperator(org);
  // Opens on the latest month that has invoices rather than on today's, which
  // is usually empty and reads as "nothing was billed".
  const latest = await readAs(context.viewer, (tx) =>
    latestInvoicedMonth(tx, context.organisationId));
  const month = monthBounds(period ?? latest ?? undefined);

  const filter = state === 'ready' || state === 'sent' || state === 'not_ready'
    ? (state as DeliveryState)
    : undefined;

  const { invoices, template, maySend } = await readAs(context.viewer, async (tx) => ({
    invoices: await listInvoicesForSending(tx, context.organisationId, {
      periodStart: month.start, periodEnd: month.end,
    }),
    template: await getInvoiceMessageTemplate(tx, context.organisationId),
    maySend: await hasPermission(tx, context.organisationId, 'invoice.send'),
  }));

  // What the deployment can actually do, read from the same adapter the worker
  // uses. The screen must not promise delivery this installation cannot make.
  const adapter = resolveEmailAdapter();
  const providerConfigured = adapter.name !== 'sink';
  const providerNote = providerConfigured
    ? ''
    : 'No email provider is configured, so nothing will actually be delivered. Each message is '
      + 'recorded and marked "not delivered" with that reason — see docs/credentials.md for what '
      + 'to set.';

  const counts = {
    all: invoices.length,
    notReady: invoices.filter((i) => i.state === 'not_ready').length,
    ready: invoices.filter((i) => i.state === 'ready').length,
    sent: invoices.filter((i) => i.state === 'sent').length,
  };
  const shown = filter ? invoices.filter((i) => i.state === filter) : invoices;
  const notReady = invoices.filter((i) => i.state === 'not_ready');
  const readyWithoutEmail = invoices.filter((i) => i.state === 'ready' && !i.residentEmail).length;

  const base = `/app/${org}/billing/invoices`;
  const href = (next: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { period: period ?? '', state: filter ?? '', ...next };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    const text = query.toString();
    return text ? `${base}?${text}` : base;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sending invoices"
        description="Posted invoices for the month, and whether the resident has been told."
        meta={
          <>
            <span className="font-medium text-ink-700">{month.label}</span>
            <span aria-hidden="true">·</span>
            <span>{counts.all} posted invoice{counts.all === 1 ? '' : 's'}</span>
            <span aria-hidden="true">·</span>
            <Link href={`/app/${org}/settings/messages`} className="text-spike-600 hover:underline">
              {template.customised ? 'Your message' : 'The default message'}
            </Link>
          </>
        }
        actions={
          <>
            <Link href={`/app/${org}/billing?period=${period ?? ''}`} className={buttonClass('secondary')}>
              Billing runs
            </Link>
          </>
        }
        toolbar={
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className="text-[length:var(--text-meta)] font-medium text-ink-500">
              Month
              <input
                type="month" name="period" defaultValue={period ?? month.start.slice(0, 7)}
                className="ml-2 rounded-[var(--radius-control)] border border-ink-200 bg-surface px-2.5 py-1.5 text-[length:var(--text-table)] text-ink-900"
              />
            </label>
            {filter ? <input type="hidden" name="state" value={filter} /> : null}
            <button type="submit" className={buttonClass('secondary')}>Show</button>
          </form>
        }
      />

      {!maySend ? (
        <PermissionState action="send invoices to residents" />
      ) : (
        <>
          <Panel
            title="Mark what should go out"
            titleId="mark-ready"
            description="Only a posted invoice can be sent. A draft can still change, and a reversed one is not owed."
          >
            <MarkReadyForm
              org={org}
              invoices={notReady.map((i) => ({
                documentId: i.documentId,
                label: `${i.residentName ?? 'Unnamed resident'} — ${i.unitLabel}`,
                detail: `${i.documentNumber} · due ${formatDate(i.dueDate, context.timeZone)}`
                  + (i.residentEmail ? '' : ' · no email address on file'),
                amount: formatMinor(i.totalMinor, i.currencyCode),
              }))}
            />
          </Panel>

          <Panel
            title="Send them"
            titleId="send"
            description={`${counts.ready} ready to send. Each one goes to the primary resident on the lease, in your organisation's name.`}
          >
            <SendReadyForm
              org={org}
              readyCount={counts.ready}
              withoutEmail={readyWithoutEmail}
              providerConfigured={providerConfigured}
              providerNote={providerNote}
            />
          </Panel>
        </>
      )}

      <Tabs
        label="Invoice delivery"
        current={filter ?? 'all'}
        tabs={[
          { key: 'all', label: 'Every invoice', href: href({ state: '' }), count: counts.all },
          { key: 'not_ready', label: 'Not ready', href: href({ state: 'not_ready' }), count: counts.notReady },
          { key: 'ready', label: 'Ready', href: href({ state: 'ready' }), count: counts.ready },
          { key: 'sent', label: 'Sent', href: href({ state: 'sent' }), count: counts.sent },
        ]}
      />

      {shown.length === 0 ? (
        <EmptyState
          title={counts.all === 0 ? 'No posted invoices this month' : 'Nothing in this state'}
          description={
            counts.all === 0
              ? 'Prepare and post a billing run for the month, and its invoices appear here.'
              : 'Every invoice in this month is in one of the other states.'
          }
          action={counts.all === 0 ? (
            <Link href={`/app/${org}/billing`} className={buttonClass('primary')}>
              Open billing
            </Link>
          ) : undefined}
        />
      ) : (
        <DataTable
          caption={`Invoices for ${month.label}`}
          stickyHead
          minWidth="56rem"
          head={(
            <tr>
              <Th>Resident</Th><Th>Unit</Th><Th>Invoice</Th><Th>Due</Th>
              <Th numeric>Amount</Th><Th>Delivery</Th><Th>What happened</Th>
              <Th><span className="sr-only">Action</span></Th>
            </tr>
          )}
        >
          {shown.map((invoice) => {
            const info = STATE[invoice.state];
            return (
              <tr key={invoice.documentId}>
                <Td>
                  <Link
                    href={`/app/${org}/leases/${invoice.leaseId}`}
                    className="font-medium text-spike-600 hover:underline"
                  >
                    {invoice.residentName ?? 'Unnamed resident'}
                  </Link>
                  <span className="block text-[length:var(--text-meta)] text-ink-400">
                    {invoice.residentEmail ?? 'No email address'}
                  </span>
                </Td>
                <Td className="text-ink-700">{invoice.unitLabel}</Td>
                <Td className="technical whitespace-nowrap text-ink-500">
                  {invoice.documentNumber}
                </Td>
                <Td className="whitespace-nowrap text-ink-500">
                  {formatDate(invoice.dueDate, context.timeZone)}
                </Td>
                <Td numeric>
                  <Money minor={invoice.totalMinor} currency={invoice.currencyCode} tone="plain" />
                </Td>
                <Td><StatusBadge tone={info.tone}>{info.label}</StatusBadge></Td>
                <Td className="text-[length:var(--text-meta)] text-ink-500">
                  {invoice.outcomeDetail ? (
                    <span title={shortOutcome(invoice.outcomeDetail).full}>
                      {shortOutcome(invoice.outcomeDetail).short}
                    </span>
                  ) : info.detail}
                  {invoice.sentAt
                    ? ` · ${formatDate(invoice.sentAt, context.timeZone)}`
                    : ''}
                </Td>
                <Td>
                  {maySend ? (
                    <span className="flex items-center gap-3">
                      {invoice.state === 'undelivered' || invoice.state === 'suppressed'
                        ? <RetryForm org={org} documentId={invoice.documentId} />
                        : null}
                      {invoice.state === 'ready' || invoice.state === 'undelivered'
                        || invoice.state === 'suppressed'
                        ? <WithdrawForm org={org} documentId={invoice.documentId} />
                        : null}
                    </span>
                  ) : null}
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}

      <Disclosure summary="What sending does, and does not, do">
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Only a <strong>posted</strong> invoice can be sent. Posting is what puts it in the
            books; until then the figure can still change.
          </li>
          <li>
            Sending changes nothing about the money. It does not mark an invoice paid, it does not
            move a balance, and it does not alter the document — that record is immutable once
            posted.
          </li>
          <li>
            An invoice is marked <strong>sent</strong> only when the email provider accepts it.
            Anything else reads &ldquo;not delivered&rdquo; with the reason.
            {providerConfigured ? '' : ` ${providerNote}`}
          </li>
          <li>
            A resident with no email address is listed as having nobody to send to, not skipped
            quietly. Add an address on the resident&rsquo;s page and mark the invoice ready again.
          </li>
          <li>
            The wording comes from{' '}
            <Link href={`/app/${org}/settings/messages`} className="text-spike-600 hover:underline">
              Settings → Message to residents
            </Link>
            , and is written into each message when you send, so editing it later cannot change
            what somebody has already received.
          </li>
        </ul>
      </Disclosure>
    </div>
  );
}
