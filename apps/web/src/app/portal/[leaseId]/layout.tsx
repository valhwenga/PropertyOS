import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PortalNav } from '@/components/portal-nav';
import { readAs, requireViewer } from '@/lib/auth';
import { loadTenancy } from '@/lib/portal-queries';

/**
 * One tenancy, with its sections down the side.
 *
 * The portal was a single page carrying everything. On a phone that is the
 * right shape and it stays that way — the sections are a row that scrolls
 * sideways, and a resident still reaches everything with one thumb. On a
 * laptop it meant scrolling past four things to reach a statement, with no
 * address to send anybody to.
 *
 * Splitting it also stops every visit paying for the statement, which is the
 * heaviest read in the portal and was being built whatever the resident came
 * for.
 *
 * The tenancy is resolved once, here: the heading, the sections and the pages
 * beneath them all describe the same lease, and a lease id in the URL that is
 * not this resident's does not resolve at all.
 */
export default async function TenancyLayout({
  children, params,
}: {
  children: React.ReactNode;
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  const tenancy = await readAs(viewer, (tx) => loadTenancy(tx, leaseId));
  if (!tenancy) notFound();

  const base = `/portal/${leaseId}`;
  return (
    <div className="md:flex md:gap-8">
      <aside className="md:w-48 md:shrink-0">
        <div className="mb-3">
          <h1 className="text-lg font-semibold tracking-tight text-ink-900 md:text-base">
            {tenancy.unit_label}
          </h1>
          <p className="text-sm text-ink-500">Lease {tenancy.reference}</p>
        </div>

        <PortalNav base={base} />

        {/* Only when there is somewhere to go back to. A single tenancy has no
            list worth a link. */}
        {viewer.residentLeases.length > 1 ? (
          <Link
            href="/portal"
            className="mt-3 hidden text-sm text-spike-600 hover:underline md:block"
          >
            Your other tenancies
          </Link>
        ) : null}
      </aside>

      {/* min-w-0 so a wide statement row shrinks instead of pushing the page
          sideways. */}
      <div className="min-w-0 flex-1 space-y-6 pt-5 md:pt-0">{children}</div>
    </div>
  );
}
