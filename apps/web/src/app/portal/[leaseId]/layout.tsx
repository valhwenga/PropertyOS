import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PortalBottomNav, PortalSidebar } from '@/components/portal-nav';
import { getBrandingForLease } from '@propertyos/domain';
import { getViewer, readAs, requireViewer } from '@/lib/auth';
import { loadLandlordContact, loadTenancy } from '@/lib/portal-queries';

/**
 * The tab says whose portal this is.
 *
 * A resident has a relationship with their landlord, so the tab, the bookmark
 * and the icon carry the landlord's name and mark — not this product's. A
 * lease the caller has no link to yields nothing at all, exactly as the page
 * itself does.
 */
export async function generateMetadata(
  { params }: { params: Promise<{ leaseId: string }> },
): Promise<Metadata> {
  const { leaseId } = await params;
  const viewer = await getViewer();
  if (!viewer?.residentLeases.some((l) => l.leaseId === leaseId)) return {};

  const { contact, branding } = await readAs(viewer, async (tx) => ({
    contact: await loadLandlordContact(tx, leaseId),
    branding: await getBrandingForLease(tx, leaseId),
  }));
  const landlord = contact?.trading_name ?? 'Your tenancy';
  return {
    title: { default: landlord, template: `%s · ${landlord}` },
    // No version to hang on the URL here: the resident-facing read returns the
    // logo itself rather than when it changed, and the route's own short
    // private cache is what bounds how stale an icon can be.
    ...(branding.hasLogo
      ? { icons: { icon: [{ url: `/portal/${leaseId}/brand-logo` }] } }
      : {}),
  };
}

/**
 * One tenancy: who it is with, which home it is, and its sections.
 *
 * Branding is the landlord's, not the platform's. A resident signed a lease
 * with a letting agency and this is that agency's portal; Spike is the
 * machinery underneath and belongs in the footer. The agency's own accent,
 * typeface and logo are applied HERE rather than in the portal shell above,
 * because a resident with two tenancies has two landlords and each tenancy
 * should look like the one it belongs to.
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

  const { tenancy, contact, branding } = await readAs(viewer, async (tx) => ({
    tenancy: await loadTenancy(tx, leaseId),
    contact: await loadLandlordContact(tx, leaseId),
    branding: await getBrandingForLease(tx, leaseId),
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
    <div
      data-brand={branding.accent}
      data-typeface={branding.typeface}
      className="md:flex md:gap-8"
    >
      <aside className="md:w-52 md:shrink-0">
        <div className="mb-4">
          {/* The landlord's own mark where they have uploaded one, their name
              where they have not. The property and unit are what tells a
              resident with two tenancies which one this is. */}
          {branding.hasLogo ? (
            <img
              src={`/portal/${leaseId}/brand-logo`}
              alt={contact?.trading_name ?? 'Your landlord'}
              className="mb-1 h-8 w-auto max-w-[11rem] object-contain"
            />
          ) : (
            <p className="text-xs font-semibold uppercase tracking-wide text-spike-700">
              {contact?.trading_name ?? 'Your landlord'}
            </p>
          )}
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
