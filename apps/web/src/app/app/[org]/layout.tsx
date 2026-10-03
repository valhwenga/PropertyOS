import { OperatorShell } from '@/components/operator-shell';
import { requireOperator } from '@/lib/auth';

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
  return (
    <OperatorShell
      slug={org}
      organisationName={context.organisationName}
      userName={context.viewer.fullName}
    >
      {children}
    </OperatorShell>
  );
}
