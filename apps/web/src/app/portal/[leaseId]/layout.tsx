import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PortalBottomNav, PortalSidebar } from '@/components/portal-nav';
import { readAs, requireViewer } from '@/lib/auth';
import { loadLandlordContact, loadTenancy } from '@/lib/portal-queries';

/**
 * One tenancy: who it is with, which home it is, and its sections.
 *
 * Branding is the landlord's, not the platform's. A resident signed a lease
 * with a letting agency and this is that agency's portal; Spike is the
 * machinery underneath and belongs in the footer. There is no logo field in
 * the schema, so the name is set as a wordmark rather than a picture — a
 * drawn-on logo would be an invented brand.
 *
 * On a laptop the sections are a sidebar. On a phone they are a bottom bar,
 * where a thumb already is, with the two remaining sections and the account
 * actions behind More. The page carries bottom padding to match the bar, so
 * nothing — least of all a form's submit button — ends up underneath it.
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

  const { tenancy, contact } = await readAs(viewer, async (tx) => ({
    tenancy: await loadTenancy(tx, leaseId),
    contact: await loadLandlordContact(tx, leaseId),
  }));
  if (!tenancy) notFound();

  const base = `/portal/${leaseId}`;
  const moreItems = [
    { href: '/account', label: 'Your profile and notifications' },
    ...(viewer.residentLeases.length > 1
      ? [{ href: '/portal', label: 'Your other tenancies' }]
      : []),
  ];

  return (
    <div className="md:flex md:gap-8">
      <aside className="md:w-52 md:shrink-0">
        <div className="mb-4">
          {/* The landlord's name, as a wordmark. The property and unit are
              what tells a resident with two tenancies which one this is. */}
          <p className="text-xs font-semibold uppercase tracking-wide text-spike-700">
            {contact?.trading_name ?? 'Your landlord'}
          </p>
          <h1 className="mt-0.5 text-lg font-semibold tracking-tight text-ink-900 md:text-base">
            {tenancy.unit_label}
          </h1>
          <p className="text-sm text-ink-500">Lease {tenancy.reference}</p>
        </div>

        <PortalSidebar base={base} />

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
          sideways. Clearing the fixed bar is the SHELL's job, not this one:
          the footer sits below this column, so padding here would leave the
          attribution under the bar. */}
      <div className="min-w-0 flex-1 space-y-6 pt-1 md:pt-0">{children}</div>

      <PortalBottomNav base={base} moreItems={moreItems} />
    </div>
  );
}
