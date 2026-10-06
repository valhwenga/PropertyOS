'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { saveOrganisationProfileAction } from '../lease-templates/actions';

function Field({
  name, label, defaultValue, hint, type = 'text', placeholder, needed, storedElsewhere,
}: {
  name: string; label: string; defaultValue?: string | null;
  hint?: string; type?: string; placeholder?: string; needed?: boolean;
  /**
   * True when a value IS stored but deliberately not shown back, as with the
   * sealed identity number. The field stays empty — putting anything in it
   * would be submitted and re-sealed — while the badge reports it as filled.
   */
  storedElsewhere?: boolean;
}) {
  const empty = !storedElsewhere && (!defaultValue || String(defaultValue).trim() === '');
  return (
    <div className="space-y-1.5">
      <label htmlFor={name} className="flex items-baseline gap-2 text-sm font-medium text-ink-700">
        {label}
        {needed ? (
          <span
            className={empty ? 'text-xs font-normal text-caution-700' : 'text-xs font-normal text-ink-400'}
            title="A published template asks for this"
          >
            {empty ? 'needed, empty' : 'used by a template'}
          </span>
        ) : null}
      </label>
      <input
        id={name} name={name} type={type} defaultValue={defaultValue ?? ''} placeholder={placeholder}
        className={`w-full rounded-lg border px-3 py-2 text-sm ${
          needed && empty ? 'border-caution-700/40 bg-caution-50' : 'border-ink-200'
        }`}
      />
      {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

function Section({ title, description, children }: {
  title: string; description: string; children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink-900">{title}</h2>
        <p className="text-xs text-ink-500">{description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export function LandlordForm({
  org, profile, needed,
}: {
  org: string;
  profile: Record<string, string | null>;
  needed: string[];
}) {
  const [state, action, pending] = useActionState(saveOrganisationProfileAction, null);
  const asks = new Set(needed);

  return (
    <Card className="p-5">
      {state && !state.ok ? (
        <div className="mb-4">
          <ErrorState title="Could not save" detail={state.message} correlationId={state.correlationId} />
        </div>
      ) : null}
      {state?.ok ? <p className="mb-4 text-sm font-medium text-positive-600">Saved.</p> : null}

      {/* Grouped by what the information IS, rather than flowing down one
          column and across. Identity, then how to reach them, then the agent. */}
      <form action={action} className="space-y-7">
        <input type="hidden" name="org" value={org} />

        <Section
          title="Who the lease names"
          description="The letting party as it should appear in the agreement."
        >
          <Field name="legalName" label="Legal name" defaultValue={profile.legal_name}
                 placeholder="Blue Crane Rentals (Pty) Ltd" needed={asks.has('landlord.name')} />
          <Field name="tradingName" label="Trading name" defaultValue={profile.trading_name}
                 hint="If you let under a different name to the registered one." />
          <Field name="registrationNumber" label="Registration number" defaultValue={profile.registration_number}
                 placeholder="2019/443321/07" needed={asks.has('landlord.registration_number')} />
          <Field name="vatNumber" label="VAT number" defaultValue={profile.vat_number}
                 needed={asks.has('landlord.vat_number')} />
          <Field
            name="identityNumber"
            label="Identity number"
            needed={asks.has('landlord.identity_number')}
            storedElsewhere={Boolean(profile.identity_number_last4)}
            hint={
              profile.identity_number_last4
                ? `Stored, ending ${profile.identity_number_last4}. Leave empty to keep it.`
                : 'For a natural-person landlord. Stored sealed, never shown back.'
            }
            placeholder={profile.identity_number_last4 ? `•••••••••${profile.identity_number_last4}` : ''}
          />
        </Section>

        <Section
          title="How to reach the landlord"
          description="A lease states where notices are sent and how the parties contact each other."
        >
          <Field name="phone" label="Telephone" defaultValue={profile.phone}
                 needed={asks.has('landlord.phone')} />
          <Field name="email" label="Email" type="email" defaultValue={profile.email}
                 needed={asks.has('landlord.email')} />
          <Field name="physicalAddress" label="Physical address" defaultValue={profile.physical_address}
                 hint="Where legal notices can be served." needed={asks.has('landlord.physical_address')} />
          <Field name="postalAddress" label="Postal address" defaultValue={profile.postal_address}
                 needed={asks.has('landlord.postal_address')} />
          <Field name="nextOfKinName" label="Next of kin" defaultValue={profile.next_of_kin_name}
                 hint="Who to contact if the landlord cannot be reached. Lease packs commonly ask for this."
                 needed={asks.has('landlord.next_of_kin_name')} />
          <Field name="nextOfKinPhone" label="Next of kin telephone" defaultValue={profile.next_of_kin_phone}
                 needed={asks.has('landlord.next_of_kin_phone')} />
        </Section>

        <Section
          title="Managing agent"
          description="Where a property practitioner acts for the landlord. Leave empty if you let directly."
        >
          <Field name="agentName" label="Agent name" defaultValue={profile.agent_name}
                 placeholder="Human Prop Pty Ltd" needed={asks.has('agent.name')} />
          <Field name="agentContact" label="Agent contact" defaultValue={profile.agent_contact}
                 needed={asks.has('agent.contact')} />
        </Section>

        <div>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save particulars'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
