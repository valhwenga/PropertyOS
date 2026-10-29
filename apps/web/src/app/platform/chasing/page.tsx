import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import {
  formatMoney, overdueLadder, platformPermissionsOf, platformSettings, trialsEnded,
} from '@propertyos/domain';
import Link from 'next/link';
import { readAs, requireViewer } from '@/lib/auth';
import { OverdueCard, type OverdueRow, type Step } from './chasing-forms';

export const metadata = { title: 'Chasing' };
export const dynamic = 'force-dynamic';

/**
 * Trials that have run out, and invoices nobody has paid.
 *
 * One screen rather than two because they are the same question asked twice:
 * who is using Spike without paying for it. A trial that ended is free service
 * nobody chose to give; an overdue invoice is service already given and not
 * paid for. An operator wants both in one place, in the order of how much
 * money is at stake.
 *
 * Ordered by what needs a decision, not by date — the same choice the debit
 * order screen makes, for the same reason.
 */
export default async function PlatformChasingPage() {
  const viewer = await requireViewer();

  const { trials, overdue, mine, settings } = await readAs(viewer, async (tx) => ({
    trials: await trialsEnded(tx, viewer.authUserId),
    overdue: await overdueLadder(tx, viewer.authUserId),
    mine: await platformPermissionsOf(tx, viewer.authUserId),
    settings: await platformSettings(tx, viewer.authUserId),
  }));

  const canSuspend = mine.includes('platform.customers.status');
  const setting = (key: string, fallback: number) => {
    const found = settings.find((s) => s.key === key);
    return found ? Number(found.effectiveValue) : fallback;
  };
  const first = setting('dunning.first_reminder_days', 3);
  const final = setting('dunning.final_notice_days', 10);
  const suspend = setting('dunning.suspend_days', 21);

  const view = (row: (typeof overdue)[number]): OverdueRow => ({
    invoiceId: row.invoiceId,
    invoiceNumber: row.invoiceNumber,
    organisationName: row.organisationName,
    slug: row.slug,
    outstanding: formatMoney(row.totalMinor - row.paidMinor, row.currencyCode),
    dueDate: row.dueDate,
    daysOverdue: row.daysOverdue,
    organisationStatus: row.organisationStatus,
    awaitingDecision: row.awaitingDecision,
    settled: row.settled,
    steps: row.steps.map((s) => ({ ...s, step: s.step as Step })),
  });

  const decide = overdue.filter((r) => r.awaitingDecision);
  const chasing = overdue.filter((r) => !r.awaitingDecision && !r.settled);
  const settled = overdue.filter((r) => r.settled);
  const owed = overdue
    .filter((r) => !r.settled)
    .reduce((sum, r) => sum + r.totalMinor - r.paidMinor, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chasing"
        description="Trials that have run out, and invoices nobody has paid. Reminders go out on their own; nothing is taken away from anybody without a person deciding."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className={decide.length > 0 ? 'border-critical-700/30 p-4' : 'p-4'}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Waiting on a decision
          </p>
          <p className="tabular mt-1 text-2xl font-semibold">{decide.length}</p>
          <p className="mt-1 text-xs text-ink-400">
            the ladder has run out of automatic steps
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Owed to Spike</p>
          <p className="tabular mt-1 text-2xl font-semibold">{formatMoney(owed, 'ZAR')}</p>
          <p className="mt-1 text-xs text-ink-400">
            across {overdue.filter((r) => !r.settled).length} overdue invoices
          </p>
        </Card>
        <Card className={trials.length > 0 ? 'border-caution-700/30 p-4' : 'p-4'}>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Trials run out
          </p>
          <p className="tabular mt-1 text-2xl font-semibold">{trials.length}</p>
          <p className="mt-1 text-xs text-ink-400">free service nobody decided to give</p>
        </Card>
      </div>

      <section aria-labelledby="trials" className="space-y-3">
        <h2 id="trials" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Trials that have ended
        </h2>
        {trials.length === 0 ? (
          <EmptyState
            title="No trial has run out"
            description="A trial ends on its date, and the next billing run issues that customer's first invoice."
          />
        ) : (
          <>
            <Card className="p-4 text-sm text-ink-700">
              These customers are past the end of their trial and have not been invoiced yet.
              Running the billing for a period that starts after their trial ended issues the
              first invoice and takes the account off trial.{' '}
              <Link
                href="/platform/billing"
                className="font-medium text-spike-600 underline underline-offset-2"
              >
                Go to billing
              </Link>
              .
            </Card>
            {trials.map((trial) => (
              <Card key={trial.organisationId} className="p-4" data-trial={trial.slug}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-ink-900">{trial.organisationName}</p>
                    <p className="text-xs text-ink-500">
                      {trial.planKey} · trial ended {trial.trialEndsOn} ·{' '}
                      <span className="tabular">{trial.daysOver}</span> days of free service
                    </p>
                  </div>
                  <Link
                    href={`/platform/customers/${trial.slug}`}
                    className="text-sm font-medium text-spike-600 underline underline-offset-2"
                  >
                    Open the customer
                  </Link>
                </div>
              </Card>
            ))}
          </>
        )}
      </section>

      {decide.length > 0 ? (
        <section aria-labelledby="decide" className="space-y-3">
          <h2 id="decide" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Waiting on a decision
          </h2>
          {decide.map((row) => (
            <OverdueCard key={row.invoiceId} row={view(row)} canSuspend={canSuspend} />
          ))}
        </section>
      ) : null}

      <section aria-labelledby="overdue" className="space-y-3">
        <h2 id="overdue" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Overdue
        </h2>
        <p className="text-xs text-ink-500">
          A reminder goes out <span className="tabular">{first}</span> days after the due date, a
          final notice at <span className="tabular">{final}</span>, and at{' '}
          <span className="tabular">{suspend}</span> the invoice is put here for somebody to
          decide about. One step a day, so a backlog climbs in order rather than all at once.
        </p>
        {chasing.length === 0 ? (
          <EmptyState
            title="Nothing is overdue"
            description="Every invoice Spike has issued is either paid or not yet due."
          />
        ) : (
          chasing.map((row) => (
            <OverdueCard key={row.invoiceId} row={view(row)} canSuspend={canSuspend} />
          ))
        )}
      </section>

      {settled.length > 0 ? (
        <details className="rounded-lg border border-ink-200 bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">
            Decided ({settled.length})
          </summary>
          <div className="mt-3 space-y-3">
            {settled.slice(0, 25).map((row) => (
              <OverdueCard key={row.invoiceId} row={view(row)} canSuspend={false} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
