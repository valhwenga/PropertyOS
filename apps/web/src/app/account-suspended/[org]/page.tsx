import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, PageHeader } from '@propertyos/ui';
import { customerClosure } from '@propertyos/domain';
import { Wordmark } from '@/components/wordmark';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';

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
 * saying how, and it does not pretend the resident portal is affected, because
 * it is not.
 *
 * For a closed account it is also the only way out. The export route has only
 * ever needed a membership, so a closed customer's archive still builds — but
 * `requireOperator` sends them here, and the only link to it was on a console
 * page they can no longer open. A way out that exists and cannot be reached is
 * the same as no way out, which is why the download is on this page.
 *
 * What this page used to say, and no longer can: "there is no path in this
 * product that deletes a customer's records." There is now, it has a date on
 * it, and the date is on this page because notice somebody else can see and
 * the customer cannot is not notice.
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
  const closure = closed
    ? await readAs(viewer, (tx) => customerClosure(tx, organisation.id))
    : null;
  const destroyed = Boolean(closure?.destroyedAt);

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
        {destroyed ? (
          <>
            <p className="font-medium text-ink-900">These records have been destroyed.</p>
            <p>
              On {formatDate(closure!.destroyedAt!.slice(0, 10), 'Africa/Johannesburg')} the
              properties, leases, contracts, documents and financial history held under this
              account were deleted, at the end of the retention period that followed its
              closure. That cannot be undone, and reopening the account would open an empty
              console.
            </p>
            <p>
              What Spike still holds is its own: the invoices it issued for the subscription,
              and its record of who closed the account and when. Spike support can read those
              to you.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-ink-900">
              {closed ? 'Nothing has been deleted yet.' : 'Nothing has been deleted.'}
            </p>
            <p>
              Every property, lease, contract, invoice, receipt and document is exactly as it
              was. {closed ? 'Closing' : 'Suspending'} an account is not a deletion request.
            </p>
            {closure ? (
              <p>
                These records are kept until{' '}
                <strong className="font-medium text-ink-900">
                  {formatDate(closure.retainUntil, 'Africa/Johannesburg')}
                </strong>
                , after which Spike may destroy them. Nothing happens automatically on that
                date and nothing is destroyed without somebody at Spike deciding to — but
                take your archive before it, because afterwards there is nothing to take.
              </p>
            ) : null}
            <p>
              Your residents are unaffected: the tenant portal is reached through their own
              lease and keeps working, so statements and invoices they already have stay
              available to them.
            </p>
            <p>
              {closed
                ? 'Reopening the account restores the console with everything in it.'
                : 'Settling what is outstanding restores the console with everything in it.'}{' '}
              Spike support can tell you what is needed — the person who{' '}
              {closed ? 'closed' : 'suspended'} it recorded a reason, and they can read it to
              you.
            </p>
          </>
        )}
      </Card>

      {closed && !destroyed ? (
        <Card className="mt-3 space-y-3 p-5 text-sm text-ink-700">
          <p className="font-medium text-ink-900">Take your records with you.</p>
          <p>
            A single archive of everything under this account, as CSV files with a sheet
            explaining what each column means: portfolios, properties, units, residents,
            leases, invoices, receipts, allocations, expenses and the rest. It is the same
            archive the console offers, and it does not need the console.
          </p>
          <p>
            <a
              href={`/app/${organisation.slug}/settings/export/export.zip`}
              className="font-medium text-spike-600 underline underline-offset-2"
            >
              Download everything
            </a>{' '}
            <span className="text-ink-500">
              — large accounts take a minute to build.
            </span>
          </p>
          <p className="text-xs text-ink-500">
            Only an owner or administrator of this account can download it, and the download
            is recorded in the account&rsquo;s audit trail.
          </p>
        </Card>
      ) : null}

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
