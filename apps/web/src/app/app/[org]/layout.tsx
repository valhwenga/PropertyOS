import { OperatorShell } from '@/components/operator-shell';
import { countUnreadNotifications, getBranding, resolveMenuPermissions } from '@propertyos/domain';
import {
  SECTION_PERMISSIONS, sectionsAwaitingSecondFactor, visibleGroups,
} from '@/components/operator-sections';
import { readAs, requireOperator } from '@/lib/auth';

export default async function OrgLayout({
  children, params,
}: {
  children: React.ReactNode;
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  // Resolves the slug against the viewer's OWN memberships. An unknown or
  // unauthorised slug redirects rather than revealing that it exists.
  const context = await requireOperator(org);
  // One transaction for both: the sidebar is rendered on every page in the
  // console, so what it costs is paid on every page in the console.
  const { unreadNotices, menu, branding } = await readAs(context.viewer, async (tx) => ({
    unreadNotices: await countUnreadNotifications(tx, context.viewer.authUserId),
    menu: await resolveMenuPermissions(tx, context.organisationId, SECTION_PERMISSIONS),
    // How this organisation chose to look. One small row, read on every page
    // for the same reason the sidebar is: it is on every page.
    branding: await getBranding(tx, context.organisationId),
  }));
  return (
    <OperatorShell
      slug={org}
      organisationName={context.organisationName}
      userName={context.viewer.fullName}
      unreadNotices={unreadNotices}
      branding={branding}
      groups={visibleGroups(menu.held)}
      // Every organisation this person belongs to, for the switcher. Resolved
      // from their own memberships, so it can never offer one they are not in.
      organisations={context.viewer.organisations.map((o) => ({ slug: o.slug, name: o.name }))}
      awaitingSecondFactor={
        sectionsAwaitingSecondFactor(menu.held, menu.withheldForSecondFactor)
      }
    >
      {children}
    </OperatorShell>
  );
}
