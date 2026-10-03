import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, EmptyState, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import { readAs, requireViewer } from '@/lib/auth';

export const metadata = { title: 'Your home' };
export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const viewer = await requireViewer();
  if (viewer.residentLeases.length === 1) {
    redirect(`/portal/${viewer.residentLeases[0]!.leaseId}`);
  }

  const leases = await readAs(viewer, async (tx) =>
    tx<{ id: string; reference: string; unit_label: string; currency_code: string;
         receivable_minor: string }[]>`
      select l.id, l.reference, l.currency_code,
             p.name || ' / ' || u.code as unit_label,
             coalesce(lb.receivable_minor, 0)::text as receivable_minor
      from leases l
      join properties p on p.id = l.property_id
      join units u on u.id = l.unit_id
      left join lease_balances lb on lb.lease_id = l.id
      order by l.start_date desc
    `,
  );

  return (
    <div className="space-y-5">
      <PageHeader title={`Hello, ${viewer.fullName}`} description="Your leases" />
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
                  <p className="text-xs text-ink-500">{l.reference}</p>
                </div>
                <div className="text-right">
                  <Money minor={l.receivable_minor} currency={l.currency_code} emphasise />
                  <p className="text-xs text-ink-400">due</p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
