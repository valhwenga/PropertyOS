import { notFound } from 'next/navigation';
import { withAnonymous } from '@propertyos/db';
import { describeApplicationLink } from '@propertyos/domain';
import { ApplicationForm } from './application-form';

export const metadata = { title: 'Rental application', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * The public application form.
 *
 * No sign-in, and no session is created by using it. The token in the URL is
 * the only credential; a revoked, expired or invented one is indistinguishable
 * here, which is deliberate — a stranger should not be able to probe for live
 * links.
 */
export default async function ApplyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const link = await withAnonymous((tx) => describeApplicationLink(tx, token));
  if (!link) notFound();

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-6">
        <p className="text-sm text-ink-500">{link.organisationName}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{link.label}</h1>
        {link.unitLabel ? (
          <p className="mt-1 text-sm text-ink-700">For {link.unitLabel}</p>
        ) : null}
      </header>

      <ApplicationForm token={token} organisationName={link.organisationName} />
    </main>
  );
}
