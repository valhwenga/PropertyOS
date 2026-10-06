import Link from 'next/link';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { LEASE_MERGE_FIELDS, listLeaseTemplates, templatePlaceholders } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { LandlordForm } from './landlord-form';

export const metadata = { title: 'Landlord particulars' };
export const dynamic = 'force-dynamic';

/** Which profile column each landlord placeholder reads. */
const FIELD_SOURCE: Record<string, string> = {
  'landlord.name': 'legal_name',
  'landlord.registration_number': 'registration_number',
  'landlord.identity_number': 'identity_number_last4',
  'landlord.vat_number': 'vat_number',
  'landlord.physical_address': 'physical_address',
  'landlord.postal_address': 'postal_address',
  'landlord.phone': 'phone',
  'landlord.email': 'email',
  'landlord.next_of_kin_name': 'next_of_kin_name',
  'landlord.next_of_kin_phone': 'next_of_kin_phone',
  'agent.name': 'agent_name',
  'agent.contact': 'agent_contact',
};

export default async function LandlordPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);

  const { profile, templates } = await readAs(context.viewer, async (tx) => {
    // The sealed identity number is deliberately NOT read back. The form shows
    // only its last four digits; nothing re-displays a full one.
    const [row] = await tx<Record<string, string | null>[]>`
      select legal_name, trading_name, registration_number, vat_number, identity_number_last4,
             physical_address, postal_address, phone, email::text as email,
             next_of_kin_name, next_of_kin_phone, agent_name, agent_contact
        from organisation_profiles where organisation_id = ${context.organisationId}
    `;
    const all = await listLeaseTemplates(tx, context.organisationId);
    const published = all.filter((t) => t.publishedVersion !== null);
    const bodies = published.length
      ? await tx<{ template_id: string; body: string }[]>`
          select distinct on (v.template_id) v.template_id, v.body
            from lease_template_versions v
           where v.organisation_id = ${context.organisationId} and v.published_at is not null
           order by v.template_id, v.version desc
        `
      : [];
    return { profile: row ?? {}, templates: bodies };
  });

  // What the published templates actually ask of this page, and what is blank.
  // Without this you only discover a missing address when a generated agreement
  // comes back with [landlord.physical_address] in it.
  const required = new Set<string>();
  for (const t of templates) {
    for (const key of templatePlaceholders(t.body)) {
      if (key in FIELD_SOURCE) required.add(key);
    }
  }
  const missing = [...required]
    .filter((key) => {
      const value = profile[FIELD_SOURCE[key]!];
      return value === null || value === undefined || String(value).trim() === '';
    })
    .map((key) => ({
      key,
      label: LEASE_MERGE_FIELDS.find((f) => f.key === key)?.label ?? key,
    }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Landlord particulars"
        description="Who the lease names as the letting party, and how to reach them. Used wherever a template asks for the landlord."
      />

      {templates.length === 0 ? null : missing.length === 0 ? (
        <Card className="border-positive-600/25 bg-positive-50 p-4">
          <p className="text-sm font-semibold text-positive-600">
            Every field your templates ask for is filled in
          </p>
          <p className="mt-1 text-sm text-ink-700">
            {required.size} landlord field{required.size === 1 ? '' : 's'} across{' '}
            {templates.length} published template{templates.length === 1 ? '' : 's'}.
          </p>
        </Card>
      ) : (
        <Card className="border-caution-700/30 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            {missing.length} field{missing.length === 1 ? '' : 's'} your templates ask for
            {missing.length === 1 ? ' is' : ' are'} empty
          </p>
          <p className="mt-1 text-sm text-ink-700">
            An agreement generated now would show {missing.length === 1 ? 'it' : 'them'} in square
            brackets and list {missing.length === 1 ? 'it' : 'them'} as incomplete.
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {missing.map((m) => (
              <li key={m.key}>
                <StatusBadge tone="caution">{m.label}</StatusBadge>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-500">
            Checked against{' '}
            <Link className="text-spike-600 hover:underline" href={`/app/${org}/settings/lease-templates`}>
              your published templates
            </Link>
            .
          </p>
        </Card>
      )}

      <LandlordForm org={org} profile={profile} needed={[...required]} />
    </div>
  );
}
