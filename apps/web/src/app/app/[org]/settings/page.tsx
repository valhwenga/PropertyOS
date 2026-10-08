import Link from 'next/link';
import { Card, PageHeader } from '@propertyos/ui';
import { requireOperator } from '@/lib/auth';

export const metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const SECTIONS = [
  {
    href: 'lease-templates',
    title: 'Lease templates',
    description:
      'Your own lease wording, with placeholders PropertyOS fills from the lease, the parties and the property.',
  },
  {
    href: 'landlord',
    title: 'Landlord particulars',
    description:
      'Who the lease names as the letting party, its registration or identity number, addresses and managing agent.',
  },
  {
    href: 'banking',
    title: 'Banking details',
    description:
      'The accounts residents pay into. Numbers are masked, changes need your authenticator code, and every change is kept.',
  },
  {
    href: 'support-access',
    title: 'Spike support access',
    description:
      'Every time Spike support opens your account: who, when, why, and for how long. Revoke at any time.',
  },
] as const;

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  await requireOperator(org);

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" description="Configuration for this organisation." />

      <div className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => (
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
    </div>
  );
}
