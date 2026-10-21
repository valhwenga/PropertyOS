import Link from 'next/link';
import { RequestForm } from './request-form';

export const metadata = { title: 'Ask for an account' };

/**
 * The one page a landlord who has never heard of us can reach.
 *
 * It says plainly that a person reads the request, because the alternative —
 * a form that promises an account in seconds and then does nothing for a day
 * — is the version people complain about. The honesty is also the design: no
 * address is verified here and nothing is charged, so a human deciding is the
 * only thing standing between this form and an organisation.
 */
export default function RequestAccessPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-6">
        <p className="text-sm font-medium text-spike-600">Spike PropertyOS</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-900">
          Ask for an account
        </h1>
        <p className="mt-2 text-sm text-ink-700">
          Tell us about your portfolio and we will set the account up and get an invitation
          link to the administrator you name. Someone reads every request, so this is not
          instant — expect to hear back within a working day.
        </p>
      </header>

      <RequestForm />

      <p className="mt-6 text-sm text-ink-500">
        Already have an account?{' '}
        <Link href="/sign-in" className="font-medium text-spike-600 hover:underline">
          Sign in
        </Link>
        . Been invited? Use the link in your invitation.
      </p>
    </main>
  );
}
