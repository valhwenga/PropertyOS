'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { provisionCustomerAction } from './actions';

/**
 * Setting up a new customer.
 *
 * The screen is built around what Spike does not get. A provisioned
 * organisation starts with nobody in it: the founding administrator arrives by
 * accepting an invitation, so there is never a Spike account inside customer
 * data for somebody to remember to remove.
 */

interface Outcome { ok: boolean; message?: string; correlationId?: string }

export interface PlanChoice { key: string; name: string; includedUnits: number }

function Field({
  name, label, required, placeholder, hint, type = 'text',
}: {
  name: string; label: string; required?: boolean; placeholder?: string;
  hint?: string; type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} required={required} placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function ProvisionForm({ plans, baseUrl }: { plans: PlanChoice[]; baseUrl: string }) {
  const [state, action, pending] = useActionState(provisionCustomerAction, null);

  const provisioned = state?.ok
    ? (state as unknown as {
        token: string; slug: string; administratorName: string;
        administratorEmail: string; expiresAt: string;
      })
    : null;

  if (provisioned) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">
          {provisioned.slug} is set up, with nobody in it
        </h2>
        <p className="mt-1 text-sm text-ink-700">
          There is no Spike account inside this organisation, and there never was one —
          so there is nothing to remember to remove. It stays empty until{' '}
          {provisioned.administratorName} accepts this link and becomes its first
          administrator.
        </p>
        <p className="mt-3 text-sm text-ink-700">
          <strong>No email has been sent.</strong> Give this to{' '}
          {provisioned.administratorEmail} yourself. It is shown once: only a hash is stored,
          so neither you nor anybody else can recover it afterwards.
        </p>
        <p className="mt-3 break-all rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-xs">
          {baseUrl}/join/{provisioned.token}
        </p>
        <p className="mt-2 text-xs text-ink-500">
          Valid until {provisioned.expiresAt.slice(0, 10)}. Until it is accepted the
          organisation is invisible to everybody, including you — it will show on the
          platform page as waiting.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <h2 className="text-sm font-semibold text-ink-900">New customer</h2>
        <p className="text-sm text-ink-500">
          This creates the organisation, its book of accounts and its trial subscription, and
          invites one person to administer it. <strong>You will not be a member of it.</strong>
        </p>

        {state && !state.ok ? (
          <ErrorState
            title="Not provisioned" detail={(state as Outcome).message ?? ''}
            correlationId={(state as Outcome).correlationId}
          />
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="name" label="Trading name" required placeholder="Karoo Rentals" />
          <Field
            name="slug" label="Address" required placeholder="karoo-rentals"
            hint="Lower-case letters, numbers and dashes. It appears in every URL they use and cannot be changed here."
          />
          <Field
            name="legalEntityName" label="Legal entity" required
            placeholder="Karoo Rentals (Pty) Ltd"
            hint="The name on their lease agreements and invoices."
          />
          <div className="space-y-1.5">
            <label htmlFor="planKey" className="block text-sm font-medium text-ink-700">
              Plan
            </label>
            <select
              id="planKey" name="planKey" required defaultValue="starter"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              {plans.map((plan) => (
                <option key={plan.key} value={plan.key}>
                  {plan.name} — up to {plan.includedUnits} units
                </option>
              ))}
            </select>
            <p className="text-xs text-ink-500">
              Starts as a trial. Nothing is charged by PropertyOS: subscription billing is
              not connected.
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="administratorName" label="Their administrator" required
            placeholder="Lerato Mahlangu"
          />
          <Field
            name="administratorEmail" label="Their email" type="email" required
            placeholder="lerato@karoo.co.za"
            hint="The address they will sign in with. No email is sent — you get a link to pass on."
          />
        </div>

        <Field
          name="reason" label="Why this account exists" required
          placeholder="Signed up by sales on 16 October; two blocks in Graaff-Reinet."
          hint="Kept on the record, so a customer nobody recognises can be explained later."
        />

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Setting up…' : 'Set up the customer'}
        </Button>
      </form>
    </Card>
  );
}
