'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { saveOrganisationProfileAction } from '../lease-templates/actions';

function Field({
  name, label, defaultValue, hint, type = 'text', placeholder,
}: {
  name: string; label: string; defaultValue?: string | null;
  hint?: string; type?: string; placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="block text-sm font-medium text-ink-700">{label}</label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue ?? ''} placeholder={placeholder}
        className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function LandlordForm({
  org, profile,
}: {
  org: string;
  profile: Record<string, string | null>;
}) {
  const [state, action, pending] = useActionState(saveOrganisationProfileAction, null);

  return (
    <Card className="p-5">
      {state && !state.ok ? (
        <div className="mb-4">
          <ErrorState title="Could not save" detail={state.message} correlationId={state.correlationId} />
        </div>
      ) : null}
      {state?.ok ? (
        <p className="mb-4 text-sm font-medium text-positive-600">Saved.</p>
      ) : null}

      <form action={action} className="grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="org" value={org} />

        <Field name="legalName" label="Legal name" defaultValue={profile.legal_name}
               placeholder="Blue Crane Rentals (Pty) Ltd" />
        <Field name="tradingName" label="Trading name" defaultValue={profile.trading_name} />
        <Field name="registrationNumber" label="Registration number" defaultValue={profile.registration_number}
               placeholder="2019/443321/07" />
        <Field name="vatNumber" label="VAT number" defaultValue={profile.vat_number} />

        <Field
          name="identityNumber"
          label="Identity number"
          hint={
            profile.identity_number_last4
              ? `Stored, ending ${profile.identity_number_last4}. Leave empty to keep it.`
              : 'For a natural-person landlord. Stored sealed.'
          }
          placeholder={profile.identity_number_last4 ? '•••••••••' + profile.identity_number_last4 : ''}
        />
        <Field name="phone" label="Telephone" defaultValue={profile.phone} />
        <Field name="email" label="Email" type="email" defaultValue={profile.email} />
        <Field name="physicalAddress" label="Physical address" defaultValue={profile.physical_address} />
        <Field name="postalAddress" label="Postal address" defaultValue={profile.postal_address} />
        <Field name="nextOfKinName" label="Next of kin" defaultValue={profile.next_of_kin_name} />
        <Field name="nextOfKinPhone" label="Next of kin telephone" defaultValue={profile.next_of_kin_phone} />
        <Field name="agentName" label="Managing agent" defaultValue={profile.agent_name}
               hint="Where a property practitioner is involved." />
        <Field name="agentContact" label="Agent contact" defaultValue={profile.agent_contact} />

        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save particulars'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
