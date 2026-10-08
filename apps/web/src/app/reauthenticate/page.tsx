import Link from 'next/link';
import { Card } from '@propertyos/ui';
import { Wordmark } from '@/components/wordmark';
import { requireViewer } from '@/lib/auth';
import { ReauthForm } from './reauth-form';
import { safeReturnTo } from './return-to';

export const metadata = { title: 'Confirm it is you' };
export const dynamic = 'force-dynamic';

/**
 * Re-verification for a sensitive change.
 *
 * Being signed in is not the same as being present. A session lasts eight
 * hours; the right to redirect where rent is paid lasts five minutes. This page
 * is how the second is obtained, and it changes nothing else about the session.
 */
export default async function ReauthenticatePage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string; action?: string }>;
}) {
  await requireViewer();
  const { returnTo, action } = await searchParams;
  const destination = safeReturnTo(returnTo);

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-spike-50 via-ink-50 to-white px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-xl"><Wordmark /></p>
          {/* A real heading, not styled text: this is the page's title, and a
              screen reader user needs to be able to find it. */}
          <h1 className="mt-2 text-lg font-semibold text-ink-900">Confirm it is you</h1>
        </div>

        <Card className="p-6 space-y-4">
          <p className="text-sm text-ink-700">
            {action
              ? `Before you ${action}, enter the current code from your authenticator app.`
              : 'Before making this change, enter the current code from your authenticator app.'}
          </p>
          <p className="text-xs text-ink-500">
            You are already signed in. This only confirms you are still the person at the
            keyboard, and it stays confirmed for about five minutes.
          </p>
          <ReauthForm returnTo={destination} />
        </Card>

        <p className="text-center text-sm">
          <Link href={destination} className="text-spike-600 hover:underline">
            Cancel and go back
          </Link>
        </p>
      </div>
    </main>
  );
}
