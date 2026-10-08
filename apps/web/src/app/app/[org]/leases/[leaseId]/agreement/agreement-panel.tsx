'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
// Imported from the money module directly, not the package barrel: this is a
// client component, and the barrel reaches the database layer, which would pull
// postgres and node:net into the browser bundle.
import { minorToMajorInput } from '@propertyos/domain/money';
import { formatDayMonthYear } from '@propertyos/domain/dates';
import { DateField } from '@/components/date-field';
import { DeliveryNote } from '@/components/delivery-note';
import { generateAgreementAction, saveTermsAction, shareAgreementAction } from './actions';

export interface TemplateOption {
  id: string;
  name: string;
  publishedVersion: number | null;
}

export interface PriorGeneration {
  id: string;
  documentId: string;
  templateName: string;
  version: number;
  missingFields: string[];
  generatedAt: string;
  issue: number;
  visibility: string;
  superseded: boolean;
}

/**
 * Sends an agreement to the resident, or takes it back.
 *
 * Only offered on the current issue: sharing a superseded draft would put the
 * wrong agreement in front of the tenant, which is worse than sharing nothing.
 */
function ShareWithResident({
  org, leaseId, generation,
}: {
  org: string; leaseId: string; generation: PriorGeneration;
}) {
  const [state, action, pending] = useActionState(shareAgreementAction, null);
  const shared = generation.visibility === 'resident_shared';

  if (generation.superseded) {
    return <span className="text-xs text-ink-400">Superseded</span>;
  }

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="leaseId" value={leaseId} />
      <input type="hidden" name="documentId" value={generation.documentId} />
      <input type="hidden" name="share" value={shared ? 'no' : 'yes'} />
      <button
        type="submit" disabled={pending}
        className="text-xs text-spike-600 hover:underline disabled:text-ink-400"
      >
        {pending
          ? (shared ? 'Removing…' : 'Sending…')
          : (shared ? 'Stop sharing' : 'Send to resident')}
      </button>
      {state && !state.ok ? (
        <span className="text-xs text-critical-700">{state.message}</span>
      ) : null}
      {/* What actually happened, in the words of what actually happened. */}
      {state?.ok && state.shared ? (
        <DeliveryNote
          inbox={state.inbox} email={state.email} emailDetail={state.emailDetail}
          overrodePreference={state.overrodePreference}
          nobody="Shared, but nobody on this lease has a portal account, so no notice was sent."
        />
      ) : null}
    </form>
  );
}

function Field({ name, label, defaultValue, hint, type = 'text', placeholder, step, lang }: {
  name: string; label: string; defaultValue?: string | null;
  hint?: string; type?: string; placeholder?: string; step?: string; lang?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-xs font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue ?? ''} placeholder={placeholder}
        step={step} lang={lang} min={type === 'number' ? 0 : undefined}
        className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

/**
 * Three states, not two.
 *
 * A bare checkbox cannot say "nobody has decided yet": unticked reads the same
 * as "not allowed", and the agreement would then print a term the operator
 * never set. Unset stays unset, and the generated document reports it as
 * incomplete instead of asserting it.
 */
function Choice({ name, label, value }: { name: string; label: string; value: string | null | undefined }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-xs font-medium text-ink-700">{label}</label>
      <select
        id={name} name={name} defaultValue={value === 'true' ? 'yes' : value === 'false' ? 'no' : ''}
        className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm"
      >
        <option value="">Not set</option>
        <option value="yes">Allowed</option>
        <option value="no">Not allowed</option>
      </select>
    </div>
  );
}

export function AgreementPanel({
  org, leaseId, templates, terms, generations,
}: {
  org: string;
  leaseId: string;
  templates: TemplateOption[];
  terms: Record<string, string | null>;
  generations: PriorGeneration[];
}) {
  const [termsState, termsSubmit, savingTerms] = useActionState(saveTermsAction, null);
  const [genState, genSubmit, generating] = useActionState(generateAgreementAction, null);
  const [showTerms, setShowTerms] = useState(false);

  const publishable = templates.filter((t) => t.publishedVersion !== null);
  const [chosenTemplate, setChosenTemplate] = useState(publishable[0]?.id ?? '');

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold text-ink-900">Lease agreement</h2>
        <button
          type="button"
          onClick={() => setShowTerms((v) => !v)}
          className="text-sm text-spike-600 hover:underline"
        >
          {showTerms ? 'Hide schedule details' : 'Schedule details'}
        </button>
      </div>

      {publishable.length === 0 ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">No published template</p>
          <p className="mt-1 text-sm text-ink-700">
            An agreement is generated from your own lease wording.{' '}
            <Link className="text-spike-600 hover:underline" href={`/app/${org}/settings/lease-templates`}>
              Create and publish a template
            </Link>{' '}
            first.
          </p>
        </Card>
      ) : (
        <Card className="p-5">
          {genState && !genState.ok ? (
            <div className="mb-4">
              <ErrorState title="Could not generate" detail={genState.message} correlationId={genState.correlationId} />
            </div>
          ) : null}

          {genState?.ok ? (
            <div className="mb-4 space-y-2">
              <p className="text-sm font-semibold text-positive-600">Agreement generated.</p>
              {genState.missingFields.length > 0 ? (
                <Card className="border-caution-700/30 bg-caution-50 p-3">
                  <p className="text-sm font-semibold text-caution-700">
                    {genState.missingFields.length} field
                    {genState.missingFields.length === 1 ? '' : 's'} had no value
                  </p>
                  <p className="mt-1 text-sm text-ink-700">
                    Each appears in the document in square brackets and is listed on its last
                    page. Complete them before anyone signs.
                  </p>
                  <ul className="mt-2 space-y-0.5">
                    {genState.missingFields.map((f) => (
                      <li key={f}><code className="text-xs text-ink-700">{f}</code></li>
                    ))}
                  </ul>
                </Card>
              ) : null}
              <Link
                className="inline-block text-sm font-medium text-spike-600 hover:underline"
                href={`/app/${org}/documents/${genState.documentId}`}
              >
                Read the PDF →
              </Link>
            </div>
          ) : null}

          <form action={genSubmit} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="leaseId" value={leaseId} />
            <div className="min-w-[16rem] space-y-1.5">
              <label htmlFor="templateId" className="block text-xs font-medium text-ink-700">
                Template
              </label>
              <select
                id="templateId" name="templateId"
                value={chosenTemplate}
                onChange={(e) => setChosenTemplate(e.target.value)}
                className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm"
              >
                {publishable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} (v{t.publishedVersion})
                  </option>
                ))}
              </select>
            </div>
            {/* Preview first: it writes nothing, and a field found missing here
                is a field fixed before a resident ever sees the lease. */}
            <Link
              href={`/app/${org}/leases/${leaseId}/agreement/preview?template=${chosenTemplate}`}
              className="rounded-lg border border-ink-200 bg-surface px-3.5 py-2 text-sm font-medium text-ink-700"
            >
              Preview
            </Link>
            <Button type="submit" variant="primary" disabled={generating}>
              {generating ? 'Generating…' : 'Generate agreement'}
            </Button>
          </form>

          <p className="mt-3 text-xs text-ink-500">
            The agreement is a draft until the parties sign it. Generating does not mark this
            lease as executed, and it is recorded in the audit trail because it reads sealed
            identity and account numbers.
          </p>
        </Card>
      )}

      {showTerms ? (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-ink-900">Schedule details</h3>
          <p className="mt-1 text-xs text-ink-500">
            Values a lease schedule asks for that live nowhere else. Rent, deposit, dates and
            the parties come from the lease itself.
          </p>

          {termsState && !termsState.ok ? (
            <div className="mt-3">
              <ErrorState title="Could not save" detail={termsState.message} correlationId={termsState.correlationId} />
            </div>
          ) : null}
          {termsState?.ok ? <p className="mt-3 text-sm font-medium text-positive-600">Saved.</p> : null}

          <form action={termsSubmit} className="mt-4 grid gap-3 sm:grid-cols-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="leaseId" value={leaseId} />

            <Field name="parkingBays" label="Parking bay(s)" defaultValue={terms.parking_bays} />
            <Field name="maxOccupants" label="Maximum occupants" type="number" defaultValue={terms.max_occupants} />
            <Field name="permanentVehicles" label="Permanent vehicles" type="number" defaultValue={terms.permanent_vehicles} />

            <Field name="adminFee" label="Admin fee (R)" type="number" step="0.01"
                   defaultValue={minorToMajorInput(terms.admin_fee_minor)} placeholder="1500.00" />
            <Field name="creditCheckFee" label="Credit check fee (R)" type="number" step="0.01"
                   defaultValue={minorToMajorInput(terms.credit_check_fee_minor)} placeholder="0.00" />
            <Field name="surchargeDetail" label="Surcharge" defaultValue={terms.surcharge_detail}
                   placeholder="Electricity only" />
            <Field name="inspectionFee" label="Inspection fee (R)" type="number" step="0.01"
                   defaultValue={minorToMajorInput(terms.inspection_fee_minor)} placeholder="0.00" />
            <Field name="cancellationPenaltyMonths" label="Cancellation penalty, months" type="number"
                   step="0.5" defaultValue={terms.cancellation_penalty_months}
                   hint="A ceiling for clause 21; the charge must still be calculated and reasonable" />

            <Field name="arrearInterestMonthlyPercent" label="Arrear interest, % per month" type="number"
                   defaultValue={terms.arrear_interest_monthly_percent} />
            <Field name="arrearInterestAnnualCapPercent" label="Annual cap, %" type="number"
                   defaultValue={terms.arrear_interest_annual_cap_percent} />
            <DateField name="keyReturnAt" label="Key return date" value={terms.key_return_at} />

            <Field name="renewalOptionMonths" label="Renewal option, months" type="number"
                   defaultValue={terms.renewal_option_months} hint="A year or two of renewal" />
            <Field name="renewalNoticeMonths" label="Renewal notice, months" type="number"
                   defaultValue={terms.renewal_notice_months} />
            <Field name="jurisdictionCourt" label="Magistrate's court" defaultValue={terms.jurisdiction_court}
                   placeholder="Randburg" />

            <div className="space-y-1.5">
              <label htmlFor="paymentMethod" className="block text-xs font-medium text-ink-700">
                Payment method
              </label>
              <select
                id="paymentMethod" name="paymentMethod" defaultValue={terms.payment_method ?? ''}
                className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm"
              >
                <option value="">—</option>
                <option value="debit_order">Debit order</option>
                <option value="bank_deposit">Bank deposit</option>
                <option value="eft">Electronic funds transfer</option>
                <option value="other">Other</option>
              </select>
            </div>
            <Field name="placeOfPayment" label="Place of payment" defaultValue={terms.place_of_payment} />
            <Field name="paymentReference" label="Payment reference" defaultValue={terms.payment_reference}
                   placeholder="The lease reference" />

            <Field name="depositRefundDays" label="Deposit refund, days" type="number"
                   defaultValue={terms.deposit_refund_days}
                   hint="7 where nothing is owed, per the Rental Housing Act" />
            <Field name="defectsNoticeDays" label="Defects notice, days" type="number"
                   defaultValue={terms.defects_notice_days}
                   hint="How long the tenant has to report defects at occupation" />
            <Field name="maintenanceCalloutFee" label="Maintenance call-out (R)" type="number" step="0.01"
                   defaultValue={minorToMajorInput(terms.maintenance_callout_fee_minor)} placeholder="0.00" />

            <Field name="earlyCancellationCap" label="Early cancellation cap (R)" type="number" step="0.01"
                   defaultValue={minorToMajorInput(terms.early_cancellation_cap_minor)} placeholder="0.00"
                   hint="A ceiling, not a charge that is automatically reasonable" />

            {/* Where the deposit goes back to. The account is the tenant's, so
                the number is sealed on the way in and only its last four digits
                ever come back out. */}
            <Field name="refundAccountHolder" label="Deposit refund account holder"
                   defaultValue={terms.refund_account_holder} />
            <Field name="refundBankName" label="Deposit refund bank" defaultValue={terms.refund_bank_name} />
            <Field name="refundBranchCode" label="Deposit refund branch code"
                   defaultValue={terms.refund_branch_code} placeholder="470010" />
            <Field name="refundAccountNumber" label="Deposit refund account number"
                   placeholder={terms.refund_account_number_last4
                     ? `•••••• ${terms.refund_account_number_last4}`
                     : 'Digits only'}
                   hint={terms.refund_account_number_last4
                     ? 'Stored. Leave empty to keep it; type a new one to replace it.'
                     : "The tenant's account. Stored sealed; only the last four digits are shown again."} />

            <Field name="complaintsThreshold" label="Complaints threshold" type="number"
                   defaultValue={terms.complaints_threshold}
                   hint="Substantiated complaints that count as a breach. Empty switches the clause off." />

            <div className="sm:col-span-3">
              <Field name="namedOccupants" label="Named occupants and relationship to tenant"
                     defaultValue={terms.named_occupants}
                     placeholder="Z C Mtombo, spouse" />
            </div>

            <Choice name="smokingAllowed" label="Smoking" value={terms.smoking_allowed} />
            <Choice name="petsAllowed" label="Pets" value={terms.pets_allowed} />
            <Field name="petsDetail" label="Pet details" defaultValue={terms.pets_detail}
                   placeholder="One small dog, kept indoors at night" />

            <div className="sm:col-span-3 space-y-1.5">
              <label htmlFor="specialConditions" className="block text-xs font-medium text-ink-700">
                Special conditions
              </label>
              <textarea
                id="specialConditions" name="specialConditions" rows={3}
                defaultValue={terms.special_conditions ?? ''}
                className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm"
              />
            </div>

            <div className="sm:col-span-3">
              <Button type="submit" variant="secondary" disabled={savingTerms}>
                {savingTerms ? 'Saving…' : 'Save schedule details'}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {generations.length > 0 ? (
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-ink-900">Previously generated</h3>
          <ul className="mt-3 space-y-2">
            {generations.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Link className="text-spike-600 hover:underline" href={`/app/${org}/documents/${g.documentId}`}>
                  Issue {g.issue} · {g.templateName} v{g.version}
                </Link>
                {/* The generated PDF opens on its own page, where it can be read
                    before it is sent rather than only downloaded. */}
                <Link
                  className="text-xs text-spike-600 hover:underline"
                  href={`/app/${org}/documents/${g.documentId}`}
                >
                  Read the PDF
                </Link>
                <span className="text-ink-400">{formatDayMonthYear(g.generatedAt)}</span>
                {g.missingFields.length > 0 ? (
                  <StatusBadge tone="caution">{g.missingFields.length} incomplete</StatusBadge>
                ) : (
                  <StatusBadge tone="positive">Complete</StatusBadge>
                )}
                {g.visibility === 'resident_shared' ? (
                  <StatusBadge tone="info">Shared with resident</StatusBadge>
                ) : null}
                <ShareWithResident org={org} leaseId={leaseId} generation={g} />
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-500">
            Read the PDF before sending it: what is in the document is what the tenant gets.
            Sending puts the agreement in the resident&rsquo;s portal and their inbox, where they can
            read and download it. Only the current issue can be shared, so a superseded draft
            never reaches them.
          </p>
        </Card>
      ) : null}
    </section>
  );
}
