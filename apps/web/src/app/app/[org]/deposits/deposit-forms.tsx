'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  approveDepositPayoutAction, approvePayoutRequestAction, closeDepositAccountAction, creditDepositInterestAction, decidePayoutRequestAction, recordDepositReceiptAction, requestDepositPayoutAction,
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

/* -------------------------------------------------------------------------- */
/* Payout requests                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Preparing a payout for somebody else to approve.
 *
 * `ApprovePayoutForm` above asks the approver for every detail and for the
 * requester's name from a dropdown — which means the approver does the data
 * entry and names their own counterparty. This is the other way round, and the
 * way it should usually be done: whoever has the facts raises the request, and
 * the approver decides on what was recorded before they arrived.
 *
 * A pending request holds nothing. The deposit balance does not move until the
 * decision.
 */
export function RequestPayoutForm({
  org, depositAccountId, evidence, today, heldLabel,
}: {
  org: string; depositAccountId: string; today: string; heldLabel: string;
  evidence: Choice[];
}) {
  const [state, action, pending] = useActionState(requestDepositPayoutAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="space-y-2">
        <Problem state={state} title="Request not raised" />
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          Request a deduction or refund
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="depositAccountId" value={depositAccountId} />
      <Problem state={state} title="Request not raised" />
      <p className="text-sm font-semibold text-ink-900">Request a payout</p>
      <p className="text-xs text-ink-700">
        {heldLabel} is held and <strong>none of it moves yet</strong>. This records what you
        are asking for, with the evidence behind it, for somebody with the deposit approval
        permission to decide. Whether a particular deduction is lawful under the Rental
        Housing Act and this lease is not something PropertyOS decides.
      </p>

      {evidence.length === 0 ? (
        <p className="text-sm text-caution-700">
          No document is attached to this lease. Upload the quotation, invoice or inspection
          first: a request without evidence is refused, so an approver is never asked to
          decide on nothing.
        </p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="requestKind" className="block text-sm font-medium text-ink-700">
                What are you asking for?
              </label>
              <select
                id="requestKind" name="kind" required defaultValue="deduction"
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="deduction">Deduction — kept for a cost incurred</option>
                <option value="refund">Refund — paid back to the resident</option>
                <option value="transfer_to_rent">
                  Transfer to rent — applied to what they owe
                </option>
              </select>
            </div>
            <Field name="amount" label="Amount" required placeholder="500.00" />
            <Field
              name="effectiveOn" label="Effective date" type="date" defaultValue={today} required
            />
            <div className="space-y-1.5">
              <label htmlFor="requestEvidence" className="block text-sm font-medium text-ink-700">
                Evidence
              </label>
              <select
                id="requestEvidence" name="evidenceDocumentId" required
                className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
              >
                <option value="">Choose a document…</option>
                {evidence.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
              <p className="text-xs text-ink-500">
                Required now, not at approval. An approver should be deciding on evidence
                somebody has already produced.
              </p>
            </div>
          </div>
          <Field
            name="description" label="What it is for" required
            placeholder="Broken window in the lounge"
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Saving…' : 'Raise the request'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

/**
 * Deciding a request.
 *
 * The requester is never asked for: it is on the stored request. That is the
 * point — the two names cannot be the same person, because one of them was
 * recorded before this screen was opened.
 */
export function DecidePayoutRequestForms({
  org, depositAccountId, request, isMine, canApprove,
}: {
  org: string; depositAccountId: string; isMine: boolean; canApprove: boolean;
  request: {
    id: string; kind: string; amountLabel: string; description: string;
    requestedByName: string | null; evidenceTitle: string | null;
  };
}) {
  const [approveState, approve, approving] = useActionState(approvePayoutRequestAction, null);
  const [decideState, decide, deciding] = useActionState(decidePayoutRequestAction, null);
  const [mode, setMode] = useState<'none' | 'approve' | 'refuse'>('none');

  const refuseLabel = isMine ? 'Withdraw this request' : 'Decline';

  if (mode === 'none') {
    return (
      <div className="space-y-2">
        <Problem state={approveState} title="Could not approve" />
        <Problem state={decideState} title="Could not record the decision" />
        <div className="flex flex-wrap gap-2">
          {canApprove && !isMine ? (
            <Button type="button" variant="primary" onClick={() => setMode('approve')}>
              Approve and pay out
            </Button>
          ) : null}
          {canApprove || isMine ? (
            <Button type="button" variant="secondary" onClick={() => setMode('refuse')}>
              {refuseLabel}
            </Button>
          ) : null}
        </div>
        {isMine ? (
          <p className="text-xs text-ink-500">
            You raised this, so somebody else must approve it. You can withdraw it.
          </p>
        ) : !canApprove ? (
          <p className="text-xs text-ink-500">
            Deciding this needs the deposit approval permission.
          </p>
        ) : null}
      </div>
    );
  }

  if (mode === 'approve') {
    return (
      <form action={approve} className="space-y-3 rounded-lg border border-caution-700/30 bg-caution-50 p-4">
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="depositAccountId" value={depositAccountId} />
        <input type="hidden" name="requestId" value={request.id} />
        <Problem state={approveState} title="Could not approve" />
        <p className="text-sm font-semibold text-caution-700">
          Paying out someone else&rsquo;s money
        </p>
        <p className="text-xs text-ink-700">
          Approving releases <strong>{request.amountLabel}</strong> from the deposit for
          &ldquo;{request.description}&rdquo;, as requested by{' '}
          {request.requestedByName ?? 'a colleague'}
          {request.evidenceTitle ? ` on the evidence of "${request.evidenceTitle}"` : ''}. The
          resident is owed that much less afterwards.
        </p>
        <Field
          name="approvalReason" label="Why you are approving it" required
          hint="Recorded permanently against this deposit, and visible to anyone reviewing it."
        />
        {request.kind === 'refund' ? (
          <Field
            name="refundReference" label="Payment reference"
            placeholder="EFT 2026-12-31 MOKOENA"
            hint="How the resident can identify the payment on their statement."
          />
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={approving}>
            {approving ? 'Approving…' : 'Approve and record'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
        </div>
      </form>
    );
  }

  return (
    <form action={decide} className="space-y-3 rounded-lg border border-ink-200 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="depositAccountId" value={depositAccountId} />
      <input type="hidden" name="requestId" value={request.id} />
      <input type="hidden" name="intent" value={isMine ? 'withdraw' : 'decline'} />
      <Problem state={decideState} title="Could not record the decision" />
      <p className="text-sm text-ink-700">
        {isMine
          ? 'Withdrawing records that you took it back. Nothing is posted, and no approver is '
            + 'recorded, because nobody approved anything.'
          : 'Declining posts nothing. The refusal and your reason stay on the record, so the '
            + 'requester knows what to fix.'}
      </p>
      <Field
        name="reason" label={isMine ? 'Why you are withdrawing it' : 'Why it is declined'} required
        placeholder={isMine
          ? 'Raised against the wrong deposit account.'
          : 'The lease has not ended, so there is nothing to refund yet.'}
      />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={deciding}>
          {deciding ? 'Saving…' : isMine ? 'Withdraw' : 'Decline'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setMode('none')}>Cancel</Button>
      </div>
    </form>
  );
}
