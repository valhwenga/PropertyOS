import { Card, PageHeader } from '@propertyos/ui';
import { readAs, requireOperator } from '@/lib/auth';
import { LandlordForm } from './landlord-form';

export const metadata = { title: 'Landlord particulars' };
export const dynamic = 'force-dynamic';

export default async function LandlordPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);

  // The sealed identity number is deliberately NOT read back here. The form
  // shows only its last four digits; nothing re-displays a full one.
  const [profile] = await readAs(context.viewer, (tx) => tx<Record<string, string | null>[]>`
    select legal_name, trading_name, registration_number, vat_number, identity_number_last4,
           physical_address, postal_address, phone, email::text as email,
           next_of_kin_name, next_of_kin_phone, agent_name, agent_contact
      from organisation_profiles where organisation_id = ${context.organisationId}
  `);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Landlord particulars"
        description="Who the lease names as the letting party, and how to reach them. Used wherever a template asks for the landlord."
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">About the identity number</p>
        <p className="mt-1 text-sm text-ink-700">
          A lease has to state it in full, so it is stored sealed and opened only when an
          agreement is generated — which is recorded in the audit trail. This form never
          shows the stored value back; leave the field empty to keep it unchanged.
        </p>
      </Card>

      <LandlordForm org={org} profile={profile ?? {}} />
    </div>
  );
}
