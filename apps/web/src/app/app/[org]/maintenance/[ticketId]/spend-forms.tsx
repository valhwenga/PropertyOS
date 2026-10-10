'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  approveQuoteAction, completeWorkOrderAction, declineQuoteAction, recordQuoteAction,
} from './actions';

/**
 * Maintenance spending, which had no interface at all.
 *
 * Three separate permissions are at work and the forms keep them visible:
 * recording a quotation is managing a ticket, approving one is authorising
 * spending, and recording the supplier's invoice is an expense. The server
 * enforces each; nothing here decides them.
 */

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title }: { state: Outcome | null; title: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

export interface Choice { id: string; label: string }

function Field({
  name, label, type = 'text', defaultValue, required, placeholder, hint,
}: {
  name: string; label: string; type?: string; defaultValue?: string;
  required?: boolean; placeholder?: string; hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue}
        required={required} placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Select({
  name, label, options, blank, required, hint,
}: {
  name: string; label: string; options: Choice[]; blank?: string;
  required?: boolean; hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <select
        id={name} name={name} required={required} defaultValue=""
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      >
        {blank ? <option value="">{blank}</option> : null}
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function RecordQuoteForm({
  org, ticketId, vendors, documents,
}: {
  org: string; ticketId: string; vendors: Choice[]; documents: Choice[];
}) {
  const [state, action, pending] = useActionState(recordQuoteAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Quotation not recorded" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Record a quotation
        </Button>
      </div>
    );
  }

  return (
    <Card className="p-4">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="ticketId" value={ticketId} />
        <h3 className="text-sm font-semibold text-ink-900">Record a quotation</h3>
        <Problem state={state} title="Quotation not recorded" />
        <p className="text-sm text-ink-500">
          Recording a quotation authorises nothing. Somebody with the spending approval
          permission has to approve it before any work is ordered.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select name="vendorId" label="Contractor" options={vendors} blank="Choose" required />
          <Field name="amount" label="Amount quoted" placeholder="4200.00" required />
          <Select
            name="documentId" label="The quotation document" options={documents}
            blank="None attached"
            hint="An approval is stronger with the quotation behind it."
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Record the quotation'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

/** Approving a quotation issues the work order and sets the spending ceiling. */
export function QuoteDecisionForms({
  org, ticketId, quoteId, amountLabel, vendorName,
}: {
  org: string; ticketId: string; quoteId: string; amountLabel: string; vendorName: string;
}) {
  const [approveState, approve, approving] = useActionState(approveQuoteAction, null);
  const [declineState, decline, declining] = useActionState(declineQuoteAction, null);
  const [mode, setMode] = useState<'none' | 'approve' | 'decline'>('none');

  if (mode === 'none') {
    return (
      <div className="space-y-2">
        <Problem state={approveState} title="Could not approve" />
        <Problem state={declineState} title="Could not decline" />
        <div className="flex gap-2">
          <Button type="button" variant="primary" onClick={() => setMode('approve')}>
            Approve and issue a work order
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode('decline')}>
            Decline
          </Button>
        </div>
      </div>
    );
  }

  if (mode === 'approve') {
    return (
      <form action={approve} className="space-y-3 rounded-lg border border-spike-300 p-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="ticketId" value={ticketId} />
        <input type="hidden" name="quoteId" value={quoteId} />
        <Problem state={approveState} title="Could not approve" />
        <p className="text-sm text-ink-700">
          Approving <strong>{amountLabel}</strong> from {vendorName} issues a work order with a
          spending ceiling. Nothing is posted to the books yet — the cost reaches them when the
          supplier&rsquo;s invoice is recorded against the completed work.
        </p>
        <Field
          name="scope" label="Scope of the work" required
          placeholder="Replace the cracked shower screen in the main bathroom."
          hint="What the contractor is authorised to do, in words the contractor would recognise."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="ceiling" label="Spending ceiling" placeholder={amountLabel}
            hint="Leave blank to use the quotation. It cannot be set below it."
          />
          <Field name="appointmentAt" label="Appointment" type="datetime-local" />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={approving}>
            {approving ? 'Approving…' : 'Approve and issue'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
        </div>
      </form>
    );
  }

  return (
    <form action={decline} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="quoteId" value={quoteId} />
      <Problem state={declineState} title="Could not decline" />
      <p className="text-sm text-ink-700">
        A declined quotation stays on the request. The reason it was refused is often more
        useful later than an approval would have been.
      </p>
      <Field
        name="reason" label="Why it is declined" required
        placeholder="Three times the second quotation for the same scope."
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={declining}>
          {declining ? 'Declining…' : 'Decline the quotation'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
      </div>
    </form>
  );
}

/** Recording the supplier's invoice against completed work. */
export function CompleteWorkOrderForm({
  org, ticketId, workOrderId, ceilingLabel, today, documents,
}: {
  org: string; ticketId: string; workOrderId: string; ceilingLabel: string | null;
  today: string; documents: Choice[];
}) {
  const [state, action, pending] = useActionState(completeWorkOrderAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Could not record completion" />
        <Button type="button" variant="primary" onClick={() => setOpen(true)}>
          Record completion and invoice
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="workOrderId" value={workOrderId} />
      <Problem state={state} title="Could not record completion" />
      <p className="text-sm text-ink-700">
        This creates the expense for the supplier&rsquo;s invoice as a <strong>draft</strong>.
        It still goes through expense approval before it reaches the books, and the same
        invoice cannot be recorded twice.
        {ceilingLabel
          ? ` An invoice above the ${ceilingLabel} ceiling is not refused — it happened — but it`
            + ' is recorded as having exceeded it.'
          : ''}
      </p>
      <Field
        name="completionNote" label="What was done" required
        placeholder="Shower screen replaced; silicone resealed."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field name="invoiceReference" label="Invoice number" required placeholder="INV-20841" />
        <Field name="invoiceAmount" label="Invoice amount" required placeholder="4200.00" />
        <Field name="expenseDate" label="Invoice date" type="date" defaultValue={today} required />
        <Select
          name="invoiceDocumentId" label="The invoice document" options={documents}
          blank="None attached"
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Record completion'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
