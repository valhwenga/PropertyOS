import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, EmptyState, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import { readAs, requireViewer } from '@/lib/auth';
import { loadTenancies } from '@/lib/portal-queries';
import { formatDate } from '@/lib/format';

export const metadata = { title: 'Your home' };
export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const viewer = await requireViewer();
  if (viewer.residentLeases.length === 1) {
    redirect(`/portal/${viewer.residentLeases[0]!.leaseId}`);
  }

  // Scoped to the leases this person holds a portal link to, which is what
  // the viewer resolved from `portal_links`. The query used to select every
  // lease row RLS allowed: their own while they are only a resident, and the
  // whole organisation's for somebody who is also a member of staff. A
  // landlord renting a flat from their own agency would have opened the portal
  // and found the portfolio in it.
  const leases = await readAs(viewer, (tx) =>
    loadTenancies(tx, viewer.residentLeases.map((l) => l.leaseId)));

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader
        title={`Hello, ${viewer.fullName}`}
        description={leases.length === 1 ? 'Your tenancy' : 'Your tenancies'}
      />
      {leases.length === 0 ? (
        <EmptyState
          title="No active lease access"
          description="Your portal access may have expired or been revoked. Contact your landlord or managing agent."
        />
      ) : (
        <div className="space-y-3">
          {leases.map((l) => (
            <Link key={l.id} href={`/portal/${l.id}`} className="block">
              <Card className="flex items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-900">{l.unit_label}</p>
                  <p className="text-xs text-ink-500">
                    {l.reference}
                    {l.end_date ? ` · ends ${formatDate(l.end_date)}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {BigInt(l.receivable_minor) > 0n ? (
                    <>
                      <Money minor={l.receivable_minor} currency={l.currency_code} emphasise />
                      <p className="text-xs text-ink-400">due</p>
                    </>
                  ) : (
                    <StatusBadge tone="positive" glyph="✓">Up to date</StatusBadge>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
