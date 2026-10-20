import { redirect } from 'next/navigation';
import { getSignInBranding } from '@propertyos/domain';
import { getViewer, withAnonymous } from '@/lib/auth';
import { SignInPanel } from '../sign-in-panel';

/**
 * A landlord's own sign-in page.
 *
 * Their staff bookmark `/sign-in/<slug>` and see their colours and their mark.
 * The slug is read with NO session — nobody is signed in on a sign-in page —
 * through a security-definer function that returns a colour, a typeface and
 * whether a logo exists, and nothing that names the organisation.
 *
 * A slug that matches nothing renders this product's own neutral page rather
 * than a 404, so the URL cannot be used to work out which organisations exist.
 */
export const metadata = { title: 'Sign in' };

export default async function BrandedSignInPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const viewer = await getViewer();
  if (viewer) redirect('/');

  const { org } = await params;
  const branding = await withAnonymous((tx) => getSignInBranding(tx, org));

  return (
    <div data-brand={branding.accent} data-typeface={branding.typeface}>
      <SignInPanel
        logoSrc={branding.hasLogo ? `/sign-in/${org}/brand-logo` : null}
        localAuth={process.env.AUTH_PROVIDER !== 'supabase'}
      />
    </div>
  );
}
