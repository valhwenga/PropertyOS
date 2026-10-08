'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { setResidentIdentityAction, updateResidentAction } from './actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state }: { state: Outcome | null }) {
  if (!state || state.ok) return null;
  return <ErrorState title="Not saved" detail={state.message ?? ''} correlationId={state.correlationId} />;
}

function Field({
  name, label, defaultValue, type = 'text', hint, required,
}: {
  name: string; label: string; defaultValue?: string | null;
  type?: string; hint?: string; required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue ?? ''} required={required}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function EditResidentForm({
  org, resident,
}: {
  org: string;
  resident: {
    id: string; first_name: string; last_name: string;
    email: string | null; phone: string | null; date_of_birth: string | null;
    communication_preference: string; status: string; notes: string | null;
  };
}) {
  const [state, action, pending] = useActionState(updateResidentAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Edit this resident
      </Button>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="residentId" value={resident.id} />
        <h2 className="text-sm font-semibold text-ink-900">Edit resident</h2>
        <Problem state={state} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="firstName" label="First name" defaultValue={resident.first_name} required />
          <Field name="lastName" label="Last name" defaultValue={resident.last_name} required />
          <Field name="email" label="Email" type="email" defaultValue={resident.email} />
          <Field name="phone" label="Phone" defaultValue={resident.phone} />
          <Field
            name="dateOfBirth" label="Date of birth" type="date"
            defaultValue={resident.date_of_birth?.slice(0, 10)}
          />
          <div className="space-y-1.5">
            <label htmlFor="communicationPreference" className="block text-sm font-medium text-ink-700">
              How they are contacted
            </label>
            <select
              id="communicationPreference" name="communicationPreference"
              defaultValue={resident.communication_preference}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="email">Email and in the portal</option>
              <option value="in_app">In the portal only — not emailed</option>
              <option value="none">No notices — not emailed</option>
            </select>
            <p className="text-xs text-ink-500">
              A lease termination notice is sent regardless of this setting.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="status" className="block text-sm font-medium text-ink-700">Status</label>
            <select
              id="status" name="status" defaultValue={resident.status}
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="prospect">Prospect</option>
              <option value="active">Active</option>
              <option value="former">Former</option>
              <option value="archived">Archived</option>
            </select>
            <p className="text-xs text-ink-500">
              Archiving hides them from lists. Nothing is deleted: leases, statements and
              history keep pointing at this record.
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="notes" className="block text-sm font-medium text-ink-700">Notes</label>
          <textarea
            id="notes" name="notes" rows={3} defaultValue={resident.notes ?? ''}
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
          <p className="text-xs text-ink-500">
            Internal. Residents never see this, and it is not the place for identity or
            banking details.
          </p>
        </div>

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Identity number capture.
 *
 * Its own form, never pre-filled, because the stored value is sealed and is not
 * displayed back — not here, not anywhere. Submitting replaces it; leaving this
 * alone changes nothing.
 */
export function IdentityNumberForm({
  org, residentId, last4,
}: {
  org: string; residentId: string; last4: string | null;
}) {
  const [state, action, pending] = useActionState(setResidentIdentityAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        {last4 ? 'Replace the identity number' : 'Capture an identity number'}
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="residentId" value={residentId} />
      <Problem state={state} />

      <p className="text-xs text-ink-700">
        Collected for the lease agreement and stored sealed. Only the last four digits are
        ever shown again, including to you. Reading the full number needs a separate
        permission and leaves an audit entry naming who read it.
      </p>

      <Field
        name="identityNumber" label="Identity or passport number" required
        hint={last4 ? `Replaces the number ending ${last4}.` : 'Spaces are ignored.'}
      />

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Store it'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
