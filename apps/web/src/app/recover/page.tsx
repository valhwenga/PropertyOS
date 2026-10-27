import Link from 'next/link';
import { Card, PageHeader } from '@propertyos/ui';
import { Wordmark } from '@/components/wordmark';
import { RecoverForm } from './recover-form';

export const metadata = { title: 'Cannot sign in' };
export const dynamic = 'force-dynamic';

/**
 * Where somebody locked out of their own account starts.
 *
 * Reachable without a session, obviously, and it asks rather than acts: this
 * page cannot change anything about an account. Somebody else decides — the
 * administrator of their own organisation where there is one, Spike only where
 * there is not.
 */
export default function RecoverPage() {
  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>
      <PageHeader
        title="Cannot sign in?"
        description="Ask for a way back into your account. Somebody has to confirm it is really you before anything changes."
      />

      <Card className="mt-6 space-y-2 p-5 text-sm text-ink-700">
        <p className="font-medium text-ink-900">Try these first.</p>
        <p>
          If you still have the recovery codes you were shown when you set up your
          authenticator, one of them signs you in on the{' '}
          <Link href="/sign-in" className="text-spike-600 underline underline-offset-2">
            sign-in page
          </Link>{' '}
          — use the recovery code box rather than the six-digit one.
        </p>
        <p>
          If a colleague administers your organisation, ringing them is faster than this
          form: they can approve it the moment they pick up.
        </p>
      </Card>

      <div className="mt-6"><RecoverForm /></div>

      <p className="mt-6 text-center text-xs text-ink-500">
        Residents: your access comes through your lease rather than a password. Ask your
        landlord or managing agent to send you a new portal link.
      </p>
    </main>
  );
}
