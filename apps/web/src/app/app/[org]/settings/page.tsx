import Link from 'next/link';
import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import {
  organisationSettings, resolveMenuPermissions, type PermissionKey,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { SectionIcon } from '@/components/icons';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const SECTIONS = [
  {
    href: 'lease-templates',
    icon: 'template' as const,
    permission: 'lease.template.manage' as PermissionKey,
    title: 'Lease templates',
    description:
      'Your own lease wording, with placeholders PropertyOS fills from the lease, the parties and the property.',
  },
  {
    href: 'landlord',
    icon: 'landlord' as const,
    permission: 'organisation.settings.manage' as PermissionKey,
    title: 'Landlord particulars',
    description:
      'Who the lease names as the letting party, its registration or identity number, addresses and managing agent.',
  },
  {
    href: 'messages',
    icon: 'message' as const,
    permission: 'organisation.settings.manage' as PermissionKey,
    title: 'Message to residents',
    description:
      'The covering message sent with an invoice, in your own words, with the fields '
      + 'PropertyOS fills in from the invoice itself.',
  },
  {
    href: 'approvals',
    icon: 'approvals' as const,
    permission: 'organisation.settings.manage' as PermissionKey,
    title: 'Approval rules',
    description:
      'Whether one person or two must approve a deposit payout, a supplier cost or a '
      + 'maintenance quotation, and above what amount.',
  },
  {
    href: 'appearance',
    icon: 'appearance' as const,
    permission: 'organisation.settings.manage' as PermissionKey,
    title: 'Appearance',
    description:
      'Your accent colour, typeface and logo, across this console and your residents’ portal. '
      + 'Light or dark is a personal choice and lives on your own profile.',
  },
  {
    href: 'banking',
    icon: 'banking' as const,
    permission: 'bank_account.read' as PermissionKey,
    title: 'Banking details',
    description:
      'The accounts residents pay into. Numbers are masked, changes need your authenticator code, and every change is kept.',
  },
  {
    href: 'staff',
    icon: 'colleagues' as const,
    permission: 'membership.manage' as PermissionKey,
    title: 'Colleagues',
    description:
      'Who can use this organisation, what they can do, and which properties they can reach. '
      + 'An invitation grants nothing until it is accepted.',
  },
  {
    href: 'audit',
    icon: 'reports' as const,
    permission: 'audit.read' as PermissionKey,
    title: 'Audit trail',
    description:
      'Every change anybody made: who, when, what it was before, and the reason they gave. '
      + 'Read-only, and nothing in it can be edited or removed.',
  },
  {
    href: 'export',
    icon: 'export' as const,
    permission: 'customer.export' as PermissionKey,
    title: 'Export your data',
    description:
      'Every record this organisation holds, as CSV files you can open anywhere. '
      + 'Yours to take whenever you want it.',
  },
  {
    href: 'subscription',
    icon: 'billing' as const,
    permission: 'organisation.settings.manage' as PermissionKey,
    title: 'Your Spike subscription',
    description:
      'What you are on, what Spike has charged you, every line on each invoice, and what is '
      + 'still owing.',
  },
  {
    href: 'support-access',
    icon: 'support' as const,
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
  const { menu, features } = await readAs(context.viewer, async (tx) => ({
    menu: await resolveMenuPermissions(
      tx, context.organisationId, SECTIONS.map((s) => s.permission),
    ),
    // Only the ones meant for them, and only to say what is OFF: listing every
    // feature that works would be noise, and the one a customer needs to know
    // about is the one that does not.
    features: await organisationSettings(tx, context.organisationId, {
      visibleToCustomerOnly: true,
    }),
  }));
  const allowed = new Set<string>(menu.held);
  const sections = SECTIONS.filter((section) => allowed.has(section.permission));
  // Withheld for want of a second factor is a different answer from withheld
  // for want of the role, and an administrator who has not enrolled holds
  // every one of these and resolves none.
  const awaiting = new Set<string>(menu.withheldForSecondFactor).size;

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Configuration for this organisation." />

      {features.some((f) => f.effectiveValue === 'false') ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            Some features are switched off for your account
          </p>
          <p className="mt-1 text-sm text-ink-700">
            Ask Spike support to switch any of these back on. Nothing about your records
            changes while a feature is off.
          </p>
          <ul className="mt-2 space-y-1.5">
            {features.filter((f) => f.effectiveValue === 'false').map((feature) => (
              <li key={feature.key} className="text-sm text-ink-700">
                <strong>{feature.name}</strong> — {feature.description}
                {feature.ownReason ? (
                  <span className="block text-xs text-ink-500">
                    {feature.ownReason}
                    {feature.setByName ? ` · switched off by ${feature.setByName} at Spike` : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((section) => (
          <Link key={section.href} href={`/app/${org}/settings/${section.href}`} className="group">
            <Card className="h-full p-5 transition-colors hover:border-spike-300">
              <div className="flex items-start gap-3">
                {/* The same drawn set the sidebar uses: one icon style, so the
                    page reads as part of the product rather than assembled. */}
                <span className="
                  mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-control)]
                  bg-spike-50 text-spike-700
                ">
                  <SectionIcon name={section.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink-900 group-hover:underline">
                    {section.title}
                  </span>
                  <span className="mt-1 block text-sm text-ink-500">{section.description}</span>
                </span>
              </div>
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
