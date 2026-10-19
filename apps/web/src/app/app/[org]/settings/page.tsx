import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import { resolveMenuPermissions, type PermissionKey } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const SECTIONS = [
  {
    href: 'lease-templates',
    permission: 'lease.template.manage' as PermissionKey,
    title: 'Lease templates',
    description:
      'Your own lease wording, with placeholders PropertyOS fills from the lease, the parties and the property.',
  },
  {
    href: 'landlord',
    permission: 'organisation.settings.manage' as PermissionKey,
    title: 'Landlord particulars',
    description:
      'Who the lease names as the letting party, its registration or identity number, addresses and managing agent.',
  },
  {
    href: 'appearance',
    permission: 'organisation.settings.manage' as PermissionKey,
    title: 'Appearance',
    description:
      'Your accent colour, typeface and logo, across this console and your residents’ portal. '
      + 'Light or dark is a personal choice and lives on your own profile.',
  },
  {
    href: 'banking',
    permission: 'bank_account.read' as PermissionKey,
    title: 'Banking details',
    description:
      'The accounts residents pay into. Numbers are masked, changes need your authenticator code, and every change is kept.',
  },
  {
    href: 'staff',
    permission: 'membership.manage' as PermissionKey,
    title: 'Colleagues',
    description:
      'Who can use this organisation, what they can do, and which properties they can reach. '
      + 'An invitation grants nothing until it is accepted.',
  },
  {
    href: 'audit',
    permission: 'audit.read' as PermissionKey,
    title: 'Audit trail',
    description:
      'Every change anybody made: who, when, what it was before, and the reason they gave. '
      + 'Read-only, and nothing in it can be edited or removed.',
  },
  {
    href: 'export',
    permission: 'customer.export' as PermissionKey,
    title: 'Export your data',
    description:
      'Every record this organisation holds, as CSV files you can open anywhere. '
      + 'Yours to take whenever you want it.',
  },
  {
    href: 'support-access',
    permission: 'support.access.manage' as PermissionKey,
    title: 'Spike support access',
    description:
      'Every time Spike support opens your account: who, when, why, and for how long. Revoke at any time.',
  },
] as const;

/**
 * Only the settings this member can actually open.
 *
 * Every one of these pages refuses a member who lacks its permission, and said
 * so after they clicked. Six cards promising six things, five of which answer
 * "you may not", is a menu that lies about what the product is.
 *
 * The refusal on each page remains; this changes what is offered, not what is
 * allowed.
 */
export default async function SettingsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);
  const menu = await readAs(context.viewer, (tx) =>
    resolveMenuPermissions(tx, context.organisationId, SECTIONS.map((s) => s.permission)));
  const allowed = new Set<string>(menu.held);
  const sections = SECTIONS.filter((section) => allowed.has(section.permission));
  // Withheld for want of a second factor is a different answer from withheld
  // for want of the role, and an administrator who has not enrolled holds
  // every one of these and resolves none.
  const awaiting = new Set<string>(menu.withheldForSecondFactor).size;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Configuration for this organisation." />

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} href={`/app/${org}/settings/${section.href}`} className="group">
            <Card className="h-full p-5 transition-colors hover:border-spike-300">
              <p className="text-sm font-semibold text-ink-900 group-hover:underline">
                {section.title}
              </p>
              <p className="mt-1 text-sm text-ink-500">{section.description}</p>
            </Card>
          </Link>
        ))}
      </div>

      {sections.length === 0 && awaiting > 0 ? (
        <EmptyState
          title="These settings need your authenticator"
          description={
            'Your roles include them, but this session has only a password, and the '
            + 'roles that configure an organisation require a second factor. Set one '
            + 'up on your account security page and they appear here.'
          }
          action={
            <Link href="/account/security" className="text-sm font-medium text-spike-700 underline">
              Set up an authenticator
            </Link>
          }
        />
      ) : null}

      {sections.length === 0 && awaiting === 0 ? (
        <EmptyState
          title="Nothing here is yours to change"
          description={
            'Every setting in this organisation is an administrator\'s to configure. '
            + 'Your own password and second factor are on your account page instead.'
          }
        />
      ) : null}
    </div>
  );
}
