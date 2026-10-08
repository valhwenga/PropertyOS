'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import { FieldErrors } from '@/components/field-errors';
import { logRequestAction } from './actions';

export interface TicketUnitChoice {
  unit_id: string;
  label: string;
  lease_id: string | null;
  resident_name: string | null;
}

const CATEGORIES = [
  ['plumbing', 'Plumbing — taps, drains, toilets, leaks'],
  ['electrical', 'Electrical — sockets, lights, wiring'],
  ['appliance', 'Appliance — stove, oven, geyser'],
  ['structural', 'Structural — walls, floors, doors, windows'],
  ['roof', 'Roof or ceiling'],
  ['heating', 'Heating or hot water'],
  ['pest', 'Pests'],
  ['security', 'Security — locks, gates, alarm'],
  ['grounds', 'Garden or outside areas'],
  ['other', 'Something else'],
] as const;

const URGENCIES = [
  ['emergency', 'Emergency', 'Danger to people or the building: burst pipe, electrical fault, fire or security risk.'],
  ['high', 'High', 'The unit is not properly habitable until it is fixed.'],
  ['normal', 'Normal', 'Needs doing, but can be scheduled.'],
  ['low', 'Low', 'Cosmetic, or can wait for the next visit.'],
] as const;

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export function LogRequestForm({ org, units }: { org: string; units: TicketUnitChoice[] }) {
  const [state, action, pending] = useActionState(logRequestAction, null);

  if (state?.ok) {
    return (
      <div className="space-y-3">
        <StatusBadge tone="positive" glyph="✓">Logged</StatusBadge>
        <p className="text-sm text-ink-700">
          Reference <strong className="tabular">{state.reference}</strong>. It starts as
          submitted; triage, approval and a work order are separate steps on the request itself.
        </p>
        <div className="flex gap-3">
          <Link
            href={`/app/${org}/maintenance/${state.ticketId}`}
            className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white"
          >
            Open the request
          </Link>
          <Link
            href={`/app/${org}/maintenance`}
            className="rounded-lg border border-ink-200 px-3.5 py-2 text-sm text-ink-700"
          >
            All requests
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="org" value={org} />

      {state && !state.ok ? (
        <div>
          <ErrorState
            title="Could not log this request"
            detail={state.message}
            correlationId={state.correlationId}
          />
          <FieldErrors errors={state.fieldErrors} />
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="unitId" className="block text-sm font-medium text-ink-700">
          Which unit?
        </label>
        <select id="unitId" name="unitId" required className={FIELD}>
          <option value="">Choose…</option>
          {units.map((u) => (
            <option key={u.unit_id} value={u.unit_id}>
              {u.label}
              {u.resident_name ? ` — ${u.resident_name}` : ' — vacant'}
            </option>
          ))}
        </select>
        <p className="text-xs text-ink-400">
          The property, the lease in force and the resident are taken from the unit, so a
          request on an occupied unit appears on that tenancy too.
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="category" className="block text-sm font-medium text-ink-700">
          What kind of problem is it?
        </label>
        <select id="category" name="category" required className={FIELD}>
          <option value="">Choose…</option>
          {CATEGORIES.map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="location" className="block text-sm font-medium text-ink-700">
          Where is it? <span className="font-normal text-ink-400">(optional)</span>
        </label>
        <input
          id="location" name="location" type="text" maxLength={160}
          placeholder="Kitchen, main bathroom, back door…" className={FIELD}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="description" className="block text-sm font-medium text-ink-700">
          What is the problem?
        </label>
        <textarea
          id="description" name="description" rows={4} required minLength={10} maxLength={4000}
          aria-describedby="description-hint" className={FIELD}
          placeholder="Who reported it and when, what is happening, and anything already tried."
        />
        <p id="description-hint" className="text-xs text-ink-400">
          At least 10 characters. This is visible to the resident and to a contractor you
          assign, so keep internal remarks for the notes on the request.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink-700">How urgent is it?</legend>
        {URGENCIES.map(([value, label, hint]) => (
          <label key={value} className="flex gap-2.5 rounded-lg border border-ink-200 p-2.5">
            <input
              type="radio" name="urgency" value={value} defaultChecked={value === 'normal'}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium text-ink-900">{label}</span>
              <span className="block text-xs text-ink-500">{hint}</span>
            </span>
          </label>
        ))}
        <p className="text-xs text-ink-400">
          Logging an emergency here does not summon anyone. It sets the priority; call your
          contractor as well.
        </p>
      </fieldset>

      <div className="space-y-1.5">
        <label htmlFor="accessNotes" className="block text-sm font-medium text-ink-700">
          Access notes <span className="font-normal text-ink-400">(optional)</span>
        </label>
        <textarea
          id="accessNotes" name="accessNotes" rows={2} maxLength={1000} className={FIELD}
          placeholder="When someone can get in, who holds a key, dogs on the property…"
        />
      </div>

      <Card className="border-caution-700/25 bg-caution-50 p-3">
        <p className="text-xs text-ink-700">
          A request is not an instruction to spend. A quote, its approval and the work order
          are separate steps, and spending above your approval limit goes to someone who holds
          one.
        </p>
      </Card>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Logging…' : 'Log the request'}
      </Button>
    </form>
  );
}
