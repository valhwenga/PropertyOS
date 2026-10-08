'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  addBankAccountAction, changeBankAccountNumberAction, setBankAccountActiveAction,
  updateBankAccountDetailsAction, verifyBankAccountAction,
} from './actions';

/**
 * Forms for banking details.
 *
 * Deliberately plain. The interesting behaviour is all server side; what these
 * add is one thing the server cannot do for itself — when a change is refused
 * because the session is no longer fresh, offer the way to fix it instead of
 * reporting a failure the operator cannot act on.
 */

/**
 * Read structurally rather than as the action's own result type, so one
 * component can render the outcome of five different commands.
 */
interface Outcome {
  ok: boolean;
  code?: string;
  message?: string;
  correlationId?: string;
}

/** The re-verification prompt, shown only for the one error that it answers. */
function Outcome({ state, returnTo, what }: { state: Outcome | null; returnTo: string; what: string }) {
  if (!state || state.ok) return null;
  if (state.code === 'reauthentication_required') {
    return (
      <Card className="border-caution-700/30 bg-caution-50 p-3">
        <p className="text-sm text-caution-700">
          Confirm it is still you before {what}. You will come straight back here.
        </p>
        <Link
          href={`/reauthenticate?returnTo=${encodeURIComponent(returnTo)}&action=${encodeURIComponent(what)}`}
          className="mt-2 inline-block rounded-lg bg-spike-500 px-3 py-1.5 text-sm font-medium text-white"
        >
          Confirm with your authenticator
        </Link>
      </Card>
    );
  }
  return <ErrorState title="Not saved" detail={state.message ?? ''} correlationId={state.correlationId} />;
}

function Text({
  name, label, defaultValue, hint, required, placeholder,
}: {
  name: string; label: string; defaultValue?: string | null;
  hint?: string; required?: boolean; placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} defaultValue={defaultValue ?? ''} required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Reason({ hint }: { hint: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor="reason" className="block text-sm font-medium text-ink-700">
        Why is this changing?
      </label>
      <input
        id="reason" name="reason" required minLength={5}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      <p className="text-xs text-ink-500">{hint}</p>
    </div>
  );
}

export function AddBankAccountForm({ org, returnTo }: { org: string; returnTo: string }) {
  const [state, action, pending] = useActionState(addBankAccountAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Add a bank account
      </Button>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <h3 className="text-sm font-semibold text-ink-900">Add a bank account</h3>
        <Outcome state={state} returnTo={returnTo} what="add a bank account" />

        <div className="grid gap-4 sm:grid-cols-2">
          <Text name="label" label="What to call it" required placeholder="Rent account" />
          <Text name="bankName" label="Bank" required placeholder="Standard Bank" />
          <Text
            name="accountHolder" label="Account holder" required
            hint="The name the account is held in, exactly as the bank has it."
          />
          <Text name="branchCode" label="Branch code" placeholder="051001" />
          <Text
            name="accountNumber" label="Account number" required
            hint="Stored sealed. Only the last four digits are ever shown again."
          />
          <div className="space-y-1.5">
            <label htmlFor="accountRole" className="block text-sm font-medium text-ink-700">
              What it is for
            </label>
            <select
              id="accountRole" name="accountRole"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="operating">Rent and operating income</option>
              <option value="deposit">Deposits held for residents</option>
            </select>
          </div>
        </div>

        <Reason hint="Recorded permanently against this account." />

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Add account'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

export function ChangeNumberForm({
  org, bankAccountId, last4, returnTo,
}: {
  org: string; bankAccountId: string; last4: string; returnTo: string;
}) {
  const [state, action, pending] = useActionState(changeBankAccountNumberAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Change the account number
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-caution-700/30 bg-caution-50 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <p className="text-sm font-semibold text-caution-700">
        Changing where rent is paid
      </p>
      <p className="text-xs text-ink-700">
        Residents pay to this account. Changing it needs your authenticator code, is recorded
        permanently, and clears the verification on the current number ending {last4} — because
        whatever was checked about that number has not been checked about the new one.
      </p>
      <Outcome state={state} returnTo={returnTo} what="change the account number" />
      <Text name="accountNumber" label="New account number" required />
      <Reason hint="For example: the landlord moved banks and supplied a new letter." />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Change the account number'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function EditDetailsForm({
  org, account, returnTo,
}: {
  org: string;
  account: { id: string; label: string; bankName: string; accountHolder: string | null; branchCode: string | null };
  returnTo: string;
}) {
  const [state, action, pending] = useActionState(updateBankAccountDetailsAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Edit details</Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="bankAccountId" value={account.id} />
      <Outcome state={state} returnTo={returnTo} what="edit these details" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text name="label" label="What to call it" defaultValue={account.label} required />
        <Text name="bankName" label="Bank" defaultValue={account.bankName} required />
        <Text name="accountHolder" label="Account holder" defaultValue={account.accountHolder} required />
        <Text name="branchCode" label="Branch code" defaultValue={account.branchCode} />
      </div>
      <p className="text-xs text-ink-500">
        The account number is not changed here. Use &ldquo;Change the account number&rdquo; for that,
        which clears the verification.
      </p>
      <Reason hint="Recorded against this account." />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save details'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function VerifyForm({
  org, bankAccountId, returnTo,
}: {
  org: string; bankAccountId: string; returnTo: string;
}) {
  const [state, action, pending] = useActionState(verifyBankAccountAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Record a verification
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <Outcome state={state} returnTo={returnTo} what="record a verification" />

      <div className="space-y-1.5">
        <label htmlFor="method" className="block text-sm font-medium text-ink-700">
          How were these details checked?
        </label>
        <select
          id="method" name="method" required
          className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
        >
          <option value="">Choose…</option>
          <option value="landlord_confirmed">The account holder confirmed them</option>
          <option value="bank_document">A bank letter or stamped statement was sighted</option>
          <option value="micro_deposit">A small payment was sent and the amount confirmed</option>
          <option value="provider_api">A bank or payment provider confirmed the account</option>
        </select>
        <p className="text-xs text-ink-500">
          Whatever you choose is what the product will say. &ldquo;The account holder confirmed
          them&rdquo; is never displayed as though a bank did.
        </p>
      </div>

      <Text name="note" label="Note (optional)" hint="Where the evidence is filed, for example." />
      <Reason hint="Recorded against this account." />

      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Record it'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function ActiveForm({
  org, bankAccountId, active, returnTo,
}: {
  org: string; bankAccountId: string; active: boolean; returnTo: string;
}) {
  const [state, action, pending] = useActionState(setBankAccountActiveAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        {active ? 'Take out of use' : 'Put back into use'}
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="bankAccountId" value={bankAccountId} />
      <input type="hidden" name="active" value={active ? 'no' : 'yes'} />
      <Outcome state={state} returnTo={returnTo} what={active ? 'take this out of use' : 'put this back into use'} />
      <p className="text-xs text-ink-700">
        Nothing is deleted. Statements, imports and reconciliations that point at this account
        keep resolving.
      </p>
      <Reason hint="Recorded against this account." />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : active ? 'Take out of use' : 'Put back into use'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
