import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import { Wordmark } from '@/components/wordmark';
import { requireViewer } from '@/lib/auth';

export const metadata = { title: 'Your organisations' };

export default async function OrganisationChooser() {
  const viewer = await requireViewer();

  // A single membership goes straight through; the chooser is only useful when
  // someone genuinely works across several customers.
  if (viewer.organisations.length === 1 && viewer.residentLeases.length === 0) {
    redirect(`/app/${viewer.organisations[0]!.slug}`);
  }

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>
      <PageHeader
        title={`Welcome, ${viewer.fullName}`}
        description="Choose an organisation to work in."
      />

      <div className="mt-6 space-y-3">
        {viewer.organisations.length === 0 ? (
          <EmptyState
            title="You are not a member of any organisation"
            description="Ask an administrator to invite you, or create a new organisation to get started."
            action={
              <Link href="/app/new" className="rounded-lg bg-spike-500 px-3.5 py-2 text-sm font-medium text-white">
                Create an organisation
              </Link>
            }
          />
        ) : (
          viewer.organisations.map((org) => (
            <Link key={org.id} href={`/app/${org.slug}`} className="block">
              <Card className="flex items-center justify-between p-4 transition-colors hover:border-spike-300">
                <div>
                  <p className="font-medium text-ink-900">{org.name}</p>
                  <p className="text-xs text-ink-500">
                    {org.currencyCode} · {org.timeZone} · {org.roles.join(', ') || 'no roles assigned'}
                  </p>
                </div>
                <span aria-hidden="true" className="text-spike-500">→</span>
              </Card>
            </Link>
          ))
        )}

        {viewer.residentLeases.length > 0 ? (
          <Link href="/portal" className="block">
            <Card className="flex items-center justify-between p-4 transition-colors hover:border-spike-300">
              <div>
                <p className="font-medium text-ink-900">Resident portal</p>
                <p className="text-xs text-ink-500">
                  {viewer.residentLeases.length} lease{viewer.residentLeases.length === 1 ? '' : 's'}
                </p>
              </div>
              <span aria-hidden="true" className="text-spike-500">→</span>
            </Card>
          </Link>
        ) : null}
      </div>
    </main>
  );
}
