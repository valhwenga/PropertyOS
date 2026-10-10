'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  approveExpenseAction, createVendorAction, payExpenseAction, recordExpenseAction,
  updateDraftExpenseAction, voidExpenseAction,
} from './actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title = 'Not saved' }: { state: Outcome | null; title?: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

export interface Choice { id: string; label: string }

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'repairs_maintenance', label: 'Repairs and maintenance' },
  { value: 'municipal', label: 'Municipal' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'levies', label: 'Levies' },
  { value: 'security', label: 'Security' },
  { value: 'cleaning', label: 'Cleaning' },
  { value: 'management', label: 'Management' },
  { value: 'capital_improvement', label: 'Capital improvement' },
  { value: 'financing', label: 'Financing' },
  { value: 'other', label: 'Other' },
];

const CLASSES: { value: string; label: string }[] = [
  { value: 'operating', label: 'Operating — counts towards net operating income' },
  { value: 'capital', label: 'Capital improvement — excluded from net operating income' },
  { value: 'financing', label: 'Financing cost — excluded from net operating income' },
  { value: 'owner_drawing', label: 'Owner drawing — not a property cost at all' },
];

function Field({
  name, label, type = 'text', defaultValue, hint, required, placeholder,
}: {
  name: string; label: string; type?: string; defaultValue?: string | null;
  hint?: string; required?: boolean; placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue ?? ''} required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Select({
  name, label, options, defaultValue, hint, blank, required,
}: {
  name: string; label: string; options: { value: string; label: string }[];
  defaultValue?: string | null; hint?: string; blank?: string; required?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <select
        id={name} name={name} defaultValue={defaultValue ?? ''} required={required}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      >
        {blank ? <option value="">{blank}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

/** The fields an expense has, shared by recording and correcting a draft. */
function ExpenseFields({
  properties, vendors, invoices, today, expense,
}: {
  properties: Choice[]; vendors: Choice[]; invoices: Choice[]; today: string;
  expense?: {
    propertyId: string | null; vendorId: string | null; category: string; costClass: string;
    description: string; amountMajor: string; expenseDate: string;
    invoiceReference: string | null; invoiceDocumentId: string | null;
  };
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          name="propertyId" label="Property" blank="Not property-specific"
          defaultValue={expense?.propertyId}
          options={properties.map((p) => ({ value: p.id, label: p.label }))}
          hint="One cost, one property. Splitting a shared cost across properties is not built yet."
        />
        <Select
          name="vendorId" label="Supplier" blank="No supplier recorded"
          defaultValue={expense?.vendorId}
          options={vendors.map((v) => ({ value: v.id, label: v.label }))}
        />
        <Select
          name="category" label="Category" required defaultValue={expense?.category ?? 'repairs_maintenance'}
          options={CATEGORIES}
        />
        <Select
          name="costClass" label="What kind of cost" required
          defaultValue={expense?.costClass ?? 'operating'} options={CLASSES}
          hint="This decides whether the cost reaches net operating income. It is never guessed from the category."
        />
        <Field
          name="amount" label="Amount" required placeholder="2400.00"
          defaultValue={expense?.amountMajor}
        />
        <Field
          name="expenseDate" label="Date of the cost" type="date" required
          defaultValue={expense?.expenseDate ?? today}
        />
        <Field
          name="invoiceReference" label="Invoice reference"
          defaultValue={expense?.invoiceReference} placeholder="INV-4471"
        />
        <Select
          name="invoiceDocumentId" label="Invoice document" blank="None attached"
          defaultValue={expense?.invoiceDocumentId}
          options={invoices.map((d) => ({ value: d.id, label: d.label }))}
          hint="Already-expensed invoices are not offered: one invoice is one cost."
        />
      </div>
      <Field
        name="description" label="What it is for" required
        defaultValue={expense?.description} placeholder="Replace the geyser element"
      />
    </>
  );
}

export function RecordExpenseForm({
  org, properties, vendors, invoices, today,
}: {
  org: string; properties: Choice[]; vendors: Choice[]; invoices: Choice[]; today: string;
}) {
  const [state, action, pending] = useActionState(recordExpenseAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)}>
        Record a cost
      </Button>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <h2 className="text-sm font-semibold text-ink-900">Record a cost</h2>
        <p className="text-sm text-ink-500">
          Saved as a draft. Nothing reaches the ledger until somebody with the approval
          permission approves it.
        </p>
        <Problem state={state} />
        {state?.ok ? <p className="text-sm font-semibold text-positive-600">Draft saved.</p> : null}

        <ExpenseFields properties={properties} vendors={vendors} invoices={invoices} today={today} />

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save as draft'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Close</Button>
        </div>
      </form>
    </Card>
  );
}

export function EditDraftForm({
  org, expenseId, properties, vendors, invoices, today, expense,
}: {
  org: string; expenseId: string; today: string;
  properties: Choice[]; vendors: Choice[]; invoices: Choice[];
  expense: Parameters<typeof ExpenseFields>[0]['expense'];
}) {
  const [state, action, pending] = useActionState(updateDraftExpenseAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Edit this draft</Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="expenseId" value={expenseId} />
      <Problem state={state} title="Could not save" />
      <ExpenseFields
        properties={properties} vendors={vendors} invoices={invoices}
        today={today} expense={expense}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** Approving posts the cost. The confirmation says where it lands. */
export function ApproveExpenseForm({
  org, expenseId, amountLabel, today,
}: {
  org: string; expenseId: string; amountLabel: string; today: string;
}) {
  const [state, action, pending] = useActionState(approveExpenseAction, null);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not approve" />
        <Button type="button" variant="primary" onClick={() => setConfirming(true)}>
          Approve this cost
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-spike-300 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="expenseId" value={expenseId} />
      <Problem state={state} title="Could not approve" />
      <p className="text-sm text-ink-700">
        Approving records <strong>{amountLabel}</strong> against the property and raises the
        obligation to the supplier. It does not pay anyone — the bank balance is unchanged until
        you record the payment.
      </p>
      <Field
        name="postingDate" label="Posting date" type="date" defaultValue={today}
        hint="Defaults to the date of the cost itself when left as it is."
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Approving…' : 'Approve and post'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** Recording that the invoice was actually paid. */
export function PayExpenseForm({
  org, expenseId, amountLabel, today,
}: {
  org: string; expenseId: string; amountLabel: string; today: string;
}) {
  const [state, action, pending] = useActionState(payExpenseAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not record the payment" />
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          Record the payment
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="expenseId" value={expenseId} />
      <Problem state={state} title="Could not record the payment" />
      <p className="text-sm text-ink-700">
        For money that has actually left the account. {amountLabel} moves from what is owed to
        the supplier onto the bank.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="paidOn" label="Date paid" type="date" defaultValue={today} required />
        <Field name="reference" label="Payment reference" placeholder="EFT 4471" />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Record the payment'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

/** Voiding, which reverses rather than erases. */
export function VoidExpenseForm({
  org, expenseId, today,
}: {
  org: string; expenseId: string; today: string;
}) {
  const [state, action, pending] = useActionState(voidExpenseAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Void this cost</Button>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-caution-700/30 bg-caution-50 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="expenseId" value={expenseId} />
      <Problem state={state} title="Could not void" />
      <p className="text-xs text-ink-700">
        Nothing is erased. If the cost was posted, its journal is reversed and both entries stay
        in the ledger — which is the difference between a correction and a cover-up.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="reason" label="Why" required placeholder="Recorded against the wrong property" />
        <Field name="postingDate" label="Posting date" type="date" defaultValue={today} required />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Voiding…' : 'Void it'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function AddVendorForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(createVendorAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Add a supplier</Button>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <h2 className="text-sm font-semibold text-ink-900">Add a supplier</h2>
        <Problem state={state} />
        {state?.ok ? <p className="text-sm font-semibold text-positive-600">Supplier added.</p> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="name" label="Name" required placeholder="Cape Plumbing" />
          <Field name="category" label="What they do" placeholder="Plumbing" />
          <Field name="email" label="Email" type="email" />
          <Field name="phone" label="Phone" />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" name="isContractor" value="yes" className="rounded border-ink-300" />
          They also take maintenance jobs
        </label>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Add supplier'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Close</Button>
        </div>
      </form>
    </Card>
  );
}
