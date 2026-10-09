'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  approveDepositPayoutAction, closeDepositAccountAction, creditDepositInterestAction,
  recordDepositReceiptAction,
} from './actions';

interface Outcome { ok: boolean; message?: string; correlationId?: string }

function Problem({ state, title = 'Not saved' }: { state: Outcome | null; title?: string }) {
  if (!state || state.ok) return null;
  return <ErrorState title={title} detail={state.message ?? ''} correlationId={state.correlationId} />;
}

function Field({
  name, label, type = 'text', defaultValue, hint, required, placeholder,
}: {
  name: string; label: string; type?: string; defaultValue?: string;
  hint?: string; required?: boolean; placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue} required={required}
        placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export interface Choice { id: string; label: string }

/**
 * Recording deposit money received.
 *
 * Says plainly what the money is, because the single most damaging mistake an
 * operator can make here is to treat a deposit as rent.
 */
export function RecordDepositForm({
  org, leases, today,
}: {
  org: string; today: string; leases: Choice[];
}) {
  const [state, action, pending] = useActionState(recordDepositReceiptAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="primary" onClick={() => setOpen(true)}>
        Record a deposit received
      </Button>
    );
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        <input type="hidden" name="org" value={org} />
        <h2 className="text-sm font-semibold text-ink-900">Record a deposit received</h2>
        <p className="text-sm text-ink-500">
          Money held on the resident&rsquo;s behalf. It is not rental income, it does not reduce
          what they owe, and it stays a liability until it is lawfully refunded or deducted.
        </p>
        <Problem state={state} />
        {state?.ok ? (
          <p className="text-sm font-semibold text-positive-600">Deposit recorded.</p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="leaseId" className="block text-sm font-medium text-ink-700">Lease</label>
            <select
              id="leaseId" name="leaseId" required
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="">Choose a lease…</option>
              {leases.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </div>
          <Field name="amount" label="Amount received" required placeholder="8000.00" />
          <Field name="receivedOn" label="Date received" type="date" defaultValue={today} required />
          <div className="space-y-1.5">
            <label htmlFor="holder" className="block text-sm font-medium text-ink-700">
              Who holds the money?
            </label>
            <select
              id="holder" name="holder"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            >
              <option value="landlord">The landlord, in their own account</option>
              <option value="agency_trust">An agency trust account</option>
              <option value="third_party_custodian">A third-party custodian</option>
            </select>
            <p className="text-xs text-ink-500">
              Recorded rather than assumed. Where a deposit is held affects who is answerable
              for it.
            </p>
          </div>
          <Field name="bankReference" label="Bank reference" />
          <Field name="description" label="Description" placeholder="Deposit on signing" />
        </div>

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Recording…' : 'Record deposit'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Close</Button>
        </div>
      </form>
    </Card>
  );
}

/** Crediting interest actually earned, from the evidence it was read from. */
export function CreditInterestForm({
  org, depositAccountId, evidence, today,
}: {
  org: string; depositAccountId: string; today: string; evidence: Choice[];
}) {
  const [state, action, pending] = useActionState(creditDepositInterestAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Credit interest
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="depositAccountId" value={depositAccountId} />
      <Problem state={state} title="Could not credit interest" />

      <p className="text-xs text-ink-700">
        PropertyOS does not accrue interest and never will from a rate somebody typed. Interest
        is recorded from the bank statement it appears on, or from a calculation that has been
        agreed and reviewed — and the evidence is attached to the entry.
      </p>

      {evidence.length === 0 ? (
        <p className="text-sm text-caution-700">
          No document is attached to this lease yet. Upload the bank statement first; interest
          cannot be credited without it.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="amount" label="Interest earned" required placeholder="120.00" />
            <Field name="effectiveOn" label="Effective date" type="date" defaultValue={today} required />
            <div className="space-y-1.5">
              <label htmlFor="basis" className="block text-sm font-medium text-ink-700">
                What is this read from?
              </label>
              <select
                id="basis" name="basis" required
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="bank_statement_evidence">A bank statement</option>
                <option value="agreed_reviewed_calculation">An agreed, reviewed calculation</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="evidenceDocumentId" className="block text-sm font-medium text-ink-700">
                Evidence
              </label>
              <select
                id="evidenceDocumentId" name="evidenceDocumentId" required
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="">Choose a document…</option>
                {evidence.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </div>
          </div>
          <Field name="description" label="Description" placeholder="Interest to 30 June" />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Saving…' : 'Credit interest'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </>
      )}
    </form>
  );
}

/**
 * Approving a deduction, refund or transfer to rent.
 *
 * The approver is whoever is signed in and is never chosen on the form. The
 * requester is, because somebody else raised it — and if they turn out to be
 * the same person, both the domain and the database refuse.
 */
export function ApprovePayoutForm({
  org, depositAccountId, evidence, colleagues, today, heldLabel,
}: {
  org: string; depositAccountId: string; today: string; heldLabel: string;
  evidence: Choice[]; colleagues: Choice[];
}) {
  const [state, action, pending] = useActionState(approveDepositPayoutAction, null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('deduction');

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Deduct, refund or transfer
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-caution-700/30 bg-caution-50 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="depositAccountId" value={depositAccountId} />
      <Problem state={state} title="Could not record this" />

      <p className="text-sm font-semibold text-caution-700">Paying out someone else&rsquo;s money</p>
      <p className="text-xs text-ink-700">
        {heldLabel} is held. A deduction or refund needs documentary evidence, a reason, and an
        approver who is not the person who asked for it — you are the approver. Whether a
        particular deduction is lawful under the Rental Housing Act and this lease is not
        something PropertyOS decides.
      </p>

      {evidence.length === 0 ? (
        <p className="text-sm text-caution-700">
          No document is attached to this lease. Upload the quotation, invoice or inspection
          first: a deduction without evidence is blocked.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="kind" className="block text-sm font-medium text-ink-700">What is this?</label>
              <select
                id="kind" name="kind" required value={kind}
                onChange={(e) => setKind(e.target.value)}
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="deduction">Deduction — kept for a cost incurred</option>
                <option value="refund">Refund — paid back to the resident</option>
                <option value="transfer_to_rent">Transfer to rent — applied to what they owe</option>
              </select>
            </div>
            <Field name="amount" label="Amount" required placeholder="500.00" />
            <Field name="effectiveOn" label="Effective date" type="date" defaultValue={today} required />
            <div className="space-y-1.5">
              <label htmlFor="requestedByUserId" className="block text-sm font-medium text-ink-700">
                Who asked for this?
              </label>
              <select
                id="requestedByUserId" name="requestedByUserId" required
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="">Choose a colleague…</option>
                {colleagues.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <p className="text-xs text-ink-500">Not you. You are approving it.</p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="payoutEvidence" className="block text-sm font-medium text-ink-700">
                Evidence
              </label>
              <select
                id="payoutEvidence" name="evidenceDocumentId" required
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="">Choose a document…</option>
                {evidence.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </div>
            {kind === 'refund' ? (
              <Field
                name="refundReference" label="Payment reference"
                placeholder="EFT 2026-12-31 MOKOENA"
                hint="How the resident can identify the payment on their statement."
              />
            ) : null}
          </div>

          <Field
            name="description" label="What is it for" required
            placeholder="Broken window in the lounge"
          />
          <Field
            name="approvalReason" label="Why you are approving it" required
            hint="Recorded permanently against this deposit, and visible to anyone reviewing it."
          />

          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Saving…' : 'Approve and record'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </>
      )}
    </form>
  );
}

/** Closing an account that holds nothing. */
export function CloseDepositForm({
  org, depositAccountId, today,
}: {
  org: string; depositAccountId: string; today: string;
}) {
  const [state, action, pending] = useActionState(closeDepositAccountAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        Close this deposit
      </Button>
    );
  }

  return (
    <form action={action} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="depositAccountId" value={depositAccountId} />
      <Problem state={state} title="Could not close" />
      <p className="text-xs text-ink-700">
        Only possible once nothing is held: a closed account with money in it is money nobody is
        looking after. Nothing is deleted — every entry stays readable.
      </p>
      <Field name="closedOn" label="Closed on" type="date" defaultValue={today} required />
      <Field name="reason" label="Why" required placeholder="Refunded in full on move out" />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Closing…' : 'Close the deposit'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}
