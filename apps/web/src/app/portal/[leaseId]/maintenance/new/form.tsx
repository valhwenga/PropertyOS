'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { submitMaintenanceRequest } from '../../actions';

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

export function MaintenanceRequestForm({ leaseId }: { leaseId: string }) {
  const [state, action, pending] = useActionState(submitMaintenanceRequest, null);

  if (state?.ok) {
    return (
      <Card className="border-positive-600/25 bg-positive-50 p-4">
        <p className="text-sm font-semibold text-positive-600">Request logged</p>
        <p className="mt-1 text-sm text-ink-700">
          Your reference is <strong className="tabular">{state.reference}</strong>. You can
          follow its progress from your account page.
        </p>
      </Card>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="leaseId" value={leaseId} />

      {state && !state.ok ? (
        <ErrorState
          title="Could not log your request"
          detail={state.message}
          correlationId={state.correlationId}
        />
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="category" className="block text-sm font-medium text-ink-700">
          What kind of problem is it?
        </label>
        <select
          id="category" name="category" required
          className="w-full rounded-lg border border-ink-200 px-3 py-3 text-base"
        >
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
          placeholder="Kitchen, main bathroom, back door…"
          className="w-full rounded-lg border border-ink-200 px-3 py-3 text-base"
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="description" className="block text-sm font-medium text-ink-700">
          Describe the problem
        </label>
        <textarea
          id="description" name="description" rows={5} required minLength={10} maxLength={4000}
          aria-describedby="description-hint"
          placeholder="Tell us what is happening, when it started, and anything you have already tried."
          className="w-full rounded-lg border border-ink-200 px-3 py-3 text-base"
        />
        <p id="description-hint" className="text-xs text-ink-400">
          At least 10 characters. The more detail you give, the less likely a second visit is needed.
        </p>
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-ink-700">How urgent is it?</legend>
        {([
          ['emergency', 'Emergency — unsafe or causing damage right now'],
          ['high', 'High — needs attention in the next day or two'],
          ['normal', 'Normal — should be fixed soon'],
          ['low', 'Low — not urgent'],
        ] as const).map(([value, label]) => (
          <label key={value} className="flex items-start gap-2.5 rounded-lg border border-ink-200 px-3 py-3 text-sm">
            <input type="radio" name="urgency" value={value} defaultChecked={value === 'normal'} className="mt-0.5" />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>

      {/* A large, thumb-friendly submit target at the bottom of the flow. */}
      <Button type="submit" variant="primary" className="w-full py-3 text-base" disabled={pending}>
        {pending ? 'Sending…' : 'Send request'}
      </Button>
    </form>
  );
}
