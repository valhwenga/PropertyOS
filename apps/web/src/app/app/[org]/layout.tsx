import { OperatorShell } from '@/components/operator-shell';
import { countUnreadNotifications } from '@propertyos/domain';
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
  const unreadNotices = await readAs(context.viewer, (tx) =>
    countUnreadNotifications(tx, context.viewer.authUserId));
  return (
    <OperatorShell
      slug={org}
      organisationName={context.organisationName}
      userName={context.viewer.fullName}
      unreadNotices={unreadNotices}
    >
      {children}
    </OperatorShell>
  );
}
