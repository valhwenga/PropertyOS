'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  recordPaymentAction, runBillingAction, saveBillingSettingsAction, voidInvoiceAction,
} from './actions';

/** Spike's own billing controls. */

interface Outcome { ok?: boolean; message?: string; correlationId?: string }

const FIELD = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm';

/**
 * Minor units to something a person reads, in the browser.
 *
 * A formatter cannot be handed down as a prop — a function does not cross the
 * server/client boundary, and React says so at runtime rather than at build
 * time — so the currency code comes down instead and the formatting happens
 * here. Grouping and the separator come from the locale, the exponent from the
 * currency.
 */
function money(minor: number, currencyCode: string): string {
  return new Intl.NumberFormat('en-ZA', {
    style: 'currency', currency: currencyCode, currencyDisplay: 'narrowSymbol',
  }).format(minor / 100);
}

function Failure({ state }: { state: Outcome | null }) {
  if (!state || state.ok) return null;
  return (
    <ErrorState
      title="That did not go through"
      detail={state.message ?? 'Nothing was changed.'}
      correlationId={state.correlationId}
    />
  );
}

export interface BillerSettings {
  legalName: string | null;
  address: string | null;
  email: string | null;
  vatNumber: string | null;
  vatRateBp: number;
  bankDetails: string | null;
  paymentTermsDays: number;
}

export function BillingSettingsForm({ settings }: { settings: BillerSettings }) {
  const [state, action, pending] = useActionState(saveBillingSettingsAction, null);
  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Who the invoice comes from</h2>
      <p className="mt-1 text-sm text-ink-700">
        Printed on every customer&rsquo;s invoice. Nothing can be issued without a legal name
        and an address, and <strong>with no VAT number the documents show no tax and are
        headed INVOICE rather than TAX INVOICE</strong> — a document that calls itself a tax
        invoice is one a customer&rsquo;s accountant will claim against.
      </p>
      <form action={action} className="mt-3 space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="legalName" className="block text-sm font-medium text-ink-700">
            Registered name
          </label>
          <input
            id="legalName" name="legalName" required minLength={2} className={FIELD}
            defaultValue={settings.legalName ?? ''}
            placeholder="Spike Technologies (Pty) Ltd"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="address" className="block text-sm font-medium text-ink-700">
            Address
          </label>
          <textarea
            id="address" name="address" required minLength={5} rows={2} className={FIELD}
            defaultValue={settings.address ?? ''}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="vatNumber" className="block text-sm font-medium text-ink-700">
              VAT registration number
            </label>
            <input
              id="vatNumber" name="vatNumber" className={FIELD}
              defaultValue={settings.vatNumber ?? ''}
            />
            <p className="text-xs text-ink-500">
              Leave empty if Spike is not a registered vendor. That is a real state, not a
              missing field.
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="vatRateBp" className="block text-sm font-medium text-ink-700">
              Rate, in basis points
            </label>
            <input
              id="vatRateBp" name="vatRateBp" type="number" min={0} max={10000} className={FIELD}
              defaultValue={settings.vatRateBp}
            />
            <p className="text-xs text-ink-500">1500 is 15%.</p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-sm font-medium text-ink-700">
              Billing email
            </label>
            <input
              id="email" name="email" type="email" className={FIELD}
              defaultValue={settings.email ?? ''}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="paymentTermsDays" className="block text-sm font-medium text-ink-700">
              Payment terms, in days
            </label>
            <input
              id="paymentTermsDays" name="paymentTermsDays" type="number" min={0} max={90}
              className={FIELD} defaultValue={settings.paymentTermsDays}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="bankDetails" className="block text-sm font-medium text-ink-700">
            Bank details, as they should be paid into
          </label>
          <textarea
            id="bankDetails" name="bankDetails" rows={2} className={FIELD}
            defaultValue={settings.bankDetails ?? ''}
          />
        </div>
        <Failure state={state} />
        {state?.ok ? (
          <p className="text-sm font-medium text-positive-600">Saved.</p>
        ) : null}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Card>
  );
}

interface RunOutcome extends Outcome {
  issuedCount?: number;
  totalMinor?: number;
  periodStart?: string;
  issued?: Array<{ organisationName: string; invoiceNumber: string; totalMinor: number }>;
  skipped?: Array<{ organisationName: string; reason: string }>;
}

export function RunBillingForm({
  defaultPeriodStart, defaultIssueDate, readyToIssue, currencyCode,
}: {
  defaultPeriodStart: string; defaultIssueDate: string; readyToIssue: boolean;
  currencyCode: string;
}) {
  const [state, action, pending] = useActionState(runBillingAction, null);
  const outcome = state?.ok ? (state as RunOutcome) : null;

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Bill a month</h2>
      <p className="mt-1 text-sm text-ink-700">
        One invoice per paying customer: the plan, plus any units above its allowance at the
        plan&rsquo;s own overage price. Pressing this twice for the same month cannot bill
        anybody twice — the second press reports who was already invoiced.
      </p>
      <p className="mt-1 text-sm text-ink-700">
        Not billed: a customer on <strong>trial</strong>, a <strong>closed</strong> account,
        and a plan priced separately. A <strong>suspended</strong> customer is billed — their
        console is shut, their records and their own billing are not.
      </p>
      <form action={action} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label htmlFor="periodStart" className="block text-sm font-medium text-ink-700">
            Month beginning
          </label>
          <input
            id="periodStart" name="periodStart" type="date" required className={FIELD}
            defaultValue={defaultPeriodStart}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="issueDate" className="block text-sm font-medium text-ink-700">
            Dated
          </label>
          <input
            id="issueDate" name="issueDate" type="date" required className={FIELD}
            defaultValue={defaultIssueDate}
          />
        </div>
        <Button type="submit" variant="primary" disabled={pending || !readyToIssue}>
          {pending ? 'Billing…' : 'Issue the invoices'}
        </Button>
      </form>
      {!readyToIssue ? (
        <p className="mt-2 text-sm text-critical-700">
          Fill in the registered name and address above first. An invoice without them is a
          number on a page.
        </p>
      ) : null}

      <Failure state={state} />

      {outcome ? (
        <div className="mt-4 space-y-3 border-t border-ink-100 pt-4">
          <p className="text-sm font-semibold text-ink-900">
            {outcome.issuedCount === 0
              ? 'Nothing was issued'
              : `${outcome.issuedCount} invoice${outcome.issuedCount === 1 ? '' : 's'} issued, ${money(outcome.totalMinor ?? 0, currencyCode)} in total`}
          </p>
          {outcome.issued && outcome.issued.length > 0 ? (
            <ul className="space-y-1 text-sm text-ink-700">
              {outcome.issued.map((i) => (
                <li key={i.invoiceNumber} className="tabular">
                  {i.invoiceNumber} · {i.organisationName} · {money(i.totalMinor, currencyCode)}
                </li>
              ))}
            </ul>
          ) : null}
          {outcome.skipped && outcome.skipped.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Not billed
              </p>
              <ul className="space-y-1 text-sm text-ink-500">
                {outcome.skipped.map((s) => (
                  <li key={s.organisationName}>{s.organisationName} — {s.reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

export function RecordPaymentForm({
  invoiceId, invoiceNumber, amountMajor, today, currencyCode,
}: {
  invoiceId: string; invoiceNumber: string; amountMajor: string; today: string;
  currencyCode: string;
}) {
  const [state, action, pending] = useActionState(recordPaymentAction, null);
  const result = state?.ok ? (state as Outcome & { settled?: boolean; shortMinor?: number }) : null;

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="currency" value={currencyCode} />
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`paid-${invoiceId}`} className="block text-xs text-ink-500">
            Amount received
          </label>
          <input
            id={`paid-${invoiceId}`} name="amount" required
            className={`${FIELD} w-28`} defaultValue={amountMajor}
            aria-label={`Amount received against ${invoiceNumber}`}
          />
        </div>
        <div>
          <label htmlFor={`on-${invoiceId}`} className="block text-xs text-ink-500">On</label>
          <input
            id={`on-${invoiceId}`} name="paidOn" type="date" required
            className={`${FIELD} w-36`} defaultValue={today}
          />
        </div>
        <div>
          <label htmlFor={`ref-${invoiceId}`} className="block text-xs text-ink-500">
            Bank reference
          </label>
          <input
            id={`ref-${invoiceId}`} name="reference" required minLength={2}
            className={`${FIELD} w-44`} placeholder="EFT 20260412"
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Recording…' : 'Record payment'}
        </Button>
      </div>
      {result && result.settled === false ? (
        <p className="text-xs text-caution-700">
          Recorded as a short payment. The invoice stays unpaid.
        </p>
      ) : null}
      {state && !state.ok ? (
        <p className="text-xs text-critical-700">{state.message}</p>
      ) : null}
    </form>
  );
}

export function VoidInvoiceForm({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState(voidInvoiceAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`void-${invoiceId}`} className="block text-xs text-ink-500">
            Why it is being withdrawn
          </label>
          <input
            id={`void-${invoiceId}`} name="reason" required minLength={5}
            className={`${FIELD} w-64`} placeholder="Billed on the wrong plan"
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Voiding…' : 'Void'}
        </Button>
      </div>
      {state && !state.ok ? (
        <p className="text-xs text-critical-700">{state.message}</p>
      ) : null}
    </form>
  );
}
