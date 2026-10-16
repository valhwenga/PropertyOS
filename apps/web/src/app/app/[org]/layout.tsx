import { OperatorShell } from '@/components/operator-shell';
import { countUnreadNotifications, resolveMenuPermissions } from '@propertyos/domain';
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
  const { unreadNotices, menu } = await readAs(context.viewer, async (tx) => ({
    unreadNotices: await countUnreadNotifications(tx, context.viewer.authUserId),
    menu: await resolveMenuPermissions(tx, context.organisationId, SECTION_PERMISSIONS),
  }));
  return (
    <OperatorShell
      slug={org}
      organisationName={context.organisationName}
      userName={context.viewer.fullName}
      unreadNotices={unreadNotices}
      groups={visibleGroups(menu.held)}
      awaitingSecondFactor={
        sectionsAwaitingSecondFactor(menu.held, menu.withheldForSecondFactor)
      }
    >
      {children}
    </OperatorShell>
  );
}
