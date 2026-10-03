import { redirect } from 'next/navigation';
import { Card } from '@propertyos/ui';
import { Wordmark } from '@/components/wordmark';
import { getViewer } from '@/lib/auth';
import { SignInForm } from './sign-in-form';

export const metadata = { title: 'Sign in' };

export default async function SignInPage() {
  const viewer = await getViewer();
  if (viewer) redirect('/');

  const localAuth = process.env.AUTH_PROVIDER !== 'supabase';

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-spike-50 via-ink-50 to-white px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <p className="text-xl"><Wordmark /></p>
          <p className="mt-2 text-sm text-ink-500">
            Rental management for South African landlords
          </p>
        </div>

        <Card className="p-6">
          <SignInForm />
        </Card>

        {localAuth ? (
          <p className="rounded-lg border border-caution-700/25 bg-caution-50 px-4 py-3 text-xs text-caution-700">
            <strong className="font-semibold">Development authentication.</strong>{' '}
            AUTH_PROVIDER is not set to <code>supabase</code>, so credentials are held in the
            local database and multi-factor authentication is not enforced. Do not use this
            mode with real customer data.
          </p>
        ) : null}
      </div>
    </main>
  );
}
