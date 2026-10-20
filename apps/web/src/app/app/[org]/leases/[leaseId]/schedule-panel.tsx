'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorState, Money, StatusBadge } from '@propertyos/ui';
import type { ChargeCategory, ChargeSchedule, EscalationDue } from '@propertyos/domain';
import { addScheduleAction, changeScheduleAction, stopScheduleAction } from './charge-actions';

/**
 * What this lease bills every month, and changing it.
 *
 * The history is shown, not just what is current, because "what were we
 * charging in March" is where a dispute starts and a list of current amounts
 * cannot answer it. A change closes one row and opens another, so the months
 * either side of an increase read as the two amounts they actually were.
 *
 * The escalation notice at the top is the reason this screen exists. The lease
 * agreement this product generates promises an increase on each anniversary,
 * the lease records the percentage, and until now nothing applied it — so the
 * product billed a figure that contradicted its own agreement. It proposes the
 * arithmetic and a person decides: software that raises somebody's rent on its
 * own is software nobody should run.
 */

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return (
    <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />
  );
}

const FIELD = `
  rounded-[var(--radius-control)] border border-ink-200 bg-surface px-2 py-1
  text-[length:var(--text-meta)] text-ink-900
`;
const LABEL = 'block text-[length:var(--text-meta)] font-medium text-ink-700';

/* ----------------------------------------------------------- the escalation */

function EscalationNotice({
  org, leaseId, due, currencySymbol, toMajor,
}: {
  org: string;
  leaseId: string;
  due: EscalationDue;
  currencySymbol: string;
  toMajor: (minor: bigint) => string;
}) {
  const [state, action, pending] = useActionState(changeScheduleAction, null);
  if (state?.ok) {
    return (
      <p className="rounded-[var(--radius-control)] bg-positive-50 px-4 py-3 text-[length:var(--text-meta)] font-medium text-positive-700">
        Applied. The next billing run raises the new amount; months already billed are not
        restated.
      </p>
    );
  }

  return (
    <form
      action={action}
      className="space-y-2 rounded-[var(--radius-control)] border border-caution-700/30 bg-caution-50 p-4"
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="scheduleId" value={due.scheduleId} />
      <Problem state={state} title="Not applied" />

      <p className="text-[length:var(--text-table)] font-semibold text-caution-700">
        An agreed rent increase is due and has not been applied
      </p>
      <p className="text-[length:var(--text-meta)] text-ink-700">
        {/* "On each anniversary" is only true at twelve months. */}
        This lease agrees {due.escalationPercent}%{' '}
        {due.intervalMonths === 12
          ? 'on each anniversary'
          : `every ${due.intervalMonths} months`}. The last one fell due on{' '}
        {due.dueOn}, and the schedule is still billing{' '}
        <Money minor={due.currentAmountMinor} currency={due.currencyCode} tone="plain" />. The
        agreed figure is{' '}
        <strong>
          <Money minor={due.proposedAmountMinor} currency={due.currencyCode} tone="plain" />
        </strong>
        {' '}— check it against the lease before applying it.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className={LABEL}>
          New rent ({currencySymbol})
          <input
            name="amount"
            inputMode="decimal"
            required
            defaultValue={toMajor(due.proposedAmountMinor)}
            className={`${FIELD} tabular w-32`}
          />
        </label>
        <label className={LABEL}>
          From
          <input
            type="date"
            name="effectiveFrom"
            required
            defaultValue={due.dueOn}
            className={FIELD}
          />
        </label>
        <label className={`${LABEL} min-w-[16rem] flex-1`}>
          Reason
          <input
            name="reason"
            required
            minLength={3}
            maxLength={300}
            defaultValue={`Agreed ${due.escalationPercent}% escalation due ${due.dueOn}`}
            className={`${FIELD} w-full`}
          />
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? 'Applying…' : 'Apply the increase'}
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------- changing / stopping */

function ChangeForm({
  org, leaseId, schedule, today, currencySymbol, toMajor,
}: {
  org: string;
  leaseId: string;
  schedule: ChargeSchedule;
  today: string;
  currencySymbol: string;
  toMajor: (minor: bigint) => string;
}) {
  const [changeState, change, changing] = useActionState(changeScheduleAction, null);
  const [stopState, stop, stopping] = useActionState(stopScheduleAction, null);
  const [open, setOpen] = useState<'none' | 'change' | 'stop'>('none');

  const billed = changeState?.ok
    && (changeState as unknown as { periodAlreadyBilled?: boolean }).periodAlreadyBilled;

  if (changeState?.ok) {
    return (
      <span className="text-[length:var(--text-meta)] font-medium text-positive-600">
        Changed from{' '}
        {(changeState as unknown as { effectiveFrom: string }).effectiveFrom}.
        {billed ? ' That month was already billed at the old amount — correct it with a credit '
          + 'note if it needs correcting.' : ''}
      </span>
    );
  }
  if (stopState?.ok) {
    return (
      <span className="text-[length:var(--text-meta)] font-medium text-positive-600">
        Stopped. What it already billed is untouched.
      </span>
    );
  }

  if (open === 'none') {
    return (
      <span className="flex gap-3">
        <button
          type="button"
          onClick={() => setOpen('change')}
          className="text-[length:var(--text-meta)] font-medium text-spike-600 hover:underline"
        >
          Change the amount
        </button>
        {schedule.category === 'rent' ? null : (
          <button
            type="button"
            onClick={() => setOpen('stop')}
            className="text-[length:var(--text-meta)] text-ink-500 hover:underline"
          >
            Stop it
          </button>
        )}
      </span>
    );
  }

  if (open === 'change') {
    return (
      <form action={change} className="w-full space-y-2">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="leaseId" value={leaseId} />
        <input type="hidden" name="scheduleId" value={schedule.id} />
        <Problem state={changeState} title="Not changed" />
        <div className="flex flex-wrap items-end gap-2">
          <label className={LABEL}>
            New amount ({currencySymbol})
            <input
              name="amount"
              inputMode="decimal"
              required
              defaultValue={toMajor(schedule.amountMinor)}
              className={`${FIELD} tabular w-28`}
            />
          </label>
          <label className={LABEL}>
            From
            <input type="date" name="effectiveFrom" required defaultValue={today}
                   className={FIELD} />
          </label>
          <label className={`${LABEL} min-w-[14rem] flex-1`}>
            Reason — it is kept with the lease
            <input name="reason" required minLength={3} maxLength={300}
                   className={`${FIELD} w-full`} />
          </label>
          <Button type="submit" variant="secondary" disabled={changing}>
            {changing ? 'Changing…' : 'Change it'}
          </Button>
          <button type="button" onClick={() => setOpen('none')}
                  className="text-[length:var(--text-meta)] text-ink-500 hover:underline">
            Cancel
          </button>
        </div>
        <p className="text-[length:var(--text-meta)] text-ink-500">
          The old amount keeps its own dates, so what was billed before stays readable as it was
          billed. Months already raised are not restated.
        </p>
      </form>
    );
  }

  return (
    <form action={stop} className="w-full space-y-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="scheduleId" value={schedule.id} />
      <Problem state={stopState} title="Not stopped" />
      <div className="flex flex-wrap items-end gap-2">
        <label className={LABEL}>
          Last day it applies
          <input type="date" name="lastDay" required defaultValue={today} className={FIELD} />
        </label>
        <label className={`${LABEL} min-w-[14rem] flex-1`}>
          Reason
          <input name="reason" required minLength={3} maxLength={300}
                 className={`${FIELD} w-full`} />
        </label>
        <Button type="submit" variant="secondary" disabled={stopping}>
          {stopping ? 'Stopping…' : 'Stop it'}
        </Button>
        <button type="button" onClick={() => setOpen('none')}
                className="text-[length:var(--text-meta)] text-ink-500 hover:underline">
          Cancel
        </button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- the panel */

export function SchedulePanel({
  org, leaseId, schedules, categories, escalation, today, currencySymbol, currencyCode,
}: {
  org: string;
  leaseId: string;
  schedules: ChargeSchedule[];
  categories: readonly ChargeCategory[];
  escalation: EscalationDue | null;
  today: string;
  currencySymbol: string;
  currencyCode: string;
}) {
  const [addState, add, adding] = useActionState(addScheduleAction, null);
  const [addOpen, setAddOpen] = useState(false);

  // Minor units to a plain major-unit string, for a form field. Kept here so
  // the server does not have to send both forms of every amount.
  const toMajor = (minor: bigint) => {
    const negative = minor < 0n;
    const digits = (negative ? -minor : minor).toString().padStart(3, '0');
    return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  };

  return (
    <div className="space-y-4 p-4">
      {escalation ? (
        <EscalationNotice
          org={org}
          leaseId={leaseId}
          due={escalation}
          currencySymbol={currencySymbol}
          toMajor={toMajor}
        />
      ) : null}

      <ul className="divide-y divide-ink-100">
        {schedules.map((schedule) => (
          <li key={schedule.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
            <span className="min-w-[9rem]">
              <span className="block text-[length:var(--text-table)] font-medium text-ink-900">
                {schedule.categoryLabel}
              </span>
              <span className="block text-[length:var(--text-meta)] text-ink-500">
                {schedule.description}
              </span>
            </span>
            <span className="tabular text-[length:var(--text-table)] text-ink-900">
              <Money minor={schedule.amountMinor} currency={currencyCode} tone="plain" />
            </span>
            <span className="text-[length:var(--text-meta)] text-ink-500">
              {schedule.startDate} → {schedule.endDate ?? 'the end of the lease'}
              {schedule.billedPeriods > 0
                ? ` · billed ${schedule.billedPeriods} ${
                  schedule.billedPeriods === 1 ? 'time' : 'times'}`
                : ''}
            </span>
            {/* Three states: a change takes effect from a future date, so the
                row carrying the new amount has not started yet. */}
            {schedule.state === 'current'
              ? <StatusBadge tone="positive">Current</StatusBadge>
              : schedule.state === 'scheduled'
                ? <StatusBadge tone="info">From {schedule.startDate}</StatusBadge>
                : <StatusBadge tone="neutral">Historical</StatusBadge>}
            {schedule.changeReason ? (
              <span className="w-full text-[length:var(--text-meta)] text-ink-500">
                {schedule.changeReason}
              </span>
            ) : null}
            {schedule.current ? (
              <span className="ml-auto">
                <ChangeForm
                  org={org}
                  leaseId={leaseId}
                  schedule={schedule}
                  today={today}
                  currencySymbol={currencySymbol}
                  toMajor={toMajor}
                />
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {addOpen ? (
        <form action={add} className="space-y-3 rounded-[var(--radius-control)] border border-ink-200 p-3">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="leaseId" value={leaseId} />
          <Problem state={addState} title="Not added" />
          <div className="grid gap-3 sm:grid-cols-4">
            <label className={LABEL}>
              What for
              <select name="category" defaultValue="parking" className={`${FIELD} w-full`}>
                {categories
                  .filter((category) => category.key !== 'rent')
                  .map((category) => (
                    <option key={category.key} value={category.key}>{category.label}</option>
                  ))}
              </select>
            </label>
            <label className={LABEL}>
              Amount a month ({currencySymbol})
              <input name="amount" inputMode="decimal" required className={`${FIELD} tabular w-full`} />
            </label>
            <label className={LABEL}>
              From
              <input type="date" name="startDate" required defaultValue={today}
                     className={`${FIELD} w-full`} />
            </label>
            <label className={LABEL}>
              Until (optional)
              <input type="date" name="endDate" className={`${FIELD} w-full`} />
            </label>
            <label className={`${LABEL} sm:col-span-4`}>
              Description on the invoice
              <input name="description" maxLength={300} className={`${FIELD} w-full`} />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" variant="secondary" disabled={adding}>
              {adding ? 'Adding…' : 'Add it'}
            </Button>
            <button type="button" onClick={() => setAddOpen(false)}
                    className="text-[length:var(--text-meta)] text-ink-500 hover:underline">
              Cancel
            </button>
            {addState?.ok ? (
              <span className="text-[length:var(--text-meta)] font-medium text-positive-600">
                Added. The next billing run raises it.
              </span>
            ) : null}
          </div>
        </form>
      ) : (
        <Button type="button" variant="secondary" onClick={() => setAddOpen(true)}>
          Add a recurring charge
        </Button>
      )}
    </div>
  );
}
