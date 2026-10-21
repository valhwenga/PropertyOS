import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, PageHeader } from '@propertyos/ui';
import { Wordmark } from '@/components/wordmark';
import { requireViewer } from '@/lib/auth';

export const metadata = { title: 'Account unavailable' };
export const dynamic = 'force-dynamic';

/**
 * Where a suspended or closed customer's staff arrive.
 *
 * Outside the `/app/[org]` segment on purpose: that segment's own guard sends
 * people here, and a page inside it would be guarded into redirecting to
 * itself.
 *
 * It says what is true and no more. It does not say "contact support" without
 * saying how, it does not imply the records are gone, and it does not pretend
 * the resident portal is affected, because it is not.
 */
export default async function AccountSuspendedPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const viewer = await requireViewer();
  const organisation = viewer.organisations.find((o) => o.slug === org);
  if (!organisation) redirect('/app');
  // Restored while they were sitting on this page: send them back in rather
  // than making them work out that it is over.
  if (organisation.status !== 'suspended' && organisation.status !== 'closed') {
    redirect(`/app/${organisation.slug}`);
  }

  const closed = organisation.status === 'closed';

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>
      <PageHeader
        title={closed ? `${organisation.name} is closed` : `${organisation.name} is suspended`}
        description={
          closed
            ? 'This account has been closed, so the console cannot be opened.'
            : 'This account has been suspended, so the console cannot be opened.'
        }
      />

      <Card className="mt-6 space-y-3 p-5 text-sm text-ink-700">
        <p className="font-medium text-ink-900">Nothing has been deleted.</p>
        <p>
          Every property, lease, contract, invoice, receipt and document is exactly as it
          was. Closing or suspending an account is not a deletion request, and there is no
          path in this product that deletes a customer&rsquo;s records.
        </p>
        <p>
          Your residents are unaffected: the tenant portal is reached through their own
          lease and keeps working, so statements and invoices they already have stay
          available to them.
        </p>
        <p>
          {closed
            ? 'Reopening the account restores the console with everything in it.'
            : 'Settling what is outstanding restores the console with everything in it.'}{' '}
          Spike support can tell you what is needed — the person who suspended it recorded a
          reason, and they can read it to you.
        </p>
      </Card>

      {viewer.organisations.length > 1 || viewer.residentLeases.length > 0 ? (
        <p className="mt-6 text-sm">
          <Link href="/app" className="text-spike-600 underline underline-offset-2">
            Your other organisations
          </Link>
        </p>
      ) : (
        <form action="/sign-out" method="post" className="mt-6">
          <button type="submit" className="text-sm text-spike-600 underline underline-offset-2">
            Sign out
          </button>
        </form>
      )}
    </main>
  );
}
