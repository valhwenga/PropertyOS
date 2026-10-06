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
import { generateAgreementAction, saveTermsAction } from './actions';

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
                Open the document →
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
                className="w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-sm"
              >
                {publishable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} (v{t.publishedVersion})
                  </option>
                ))}
              </select>
            </div>
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

            <Choice name="smokingAllowed" label="Smoking" value={terms.smoking_allowed} />
            <Choice name="petsAllowed" label="Pets" value={terms.pets_allowed} />

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
                  {g.templateName} v{g.version}
                </Link>
                <span className="text-ink-400">{formatDayMonthYear(g.generatedAt)}</span>
                {g.missingFields.length > 0 ? (
                  <StatusBadge tone="caution">{g.missingFields.length} incomplete</StatusBadge>
                ) : (
                  <StatusBadge tone="positive">Complete</StatusBadge>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
