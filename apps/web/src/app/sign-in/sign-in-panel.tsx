import { Card } from '@propertyos/ui';
import { Wordmark } from '@/components/wordmark';
import { SignInForm } from './sign-in-form';

/**
 * The sign-in page, with whatever mark belongs at the top of it.
 *
 * `/sign-in` is this product's own page and carries its wordmark. A landlord's
 * staff reach `/sign-in/<their-slug>` instead and see their own logo and accent
 * colour, because signing in several times a week to somebody else's brand is
 * exactly the kind of small daily reminder a white-label product should not be
 * giving them.
 *
 * The form itself is identical in both cases, deliberately. Credentials are not
 * scoped to an organisation — a person may work for two agencies on one login —
 * so a branded URL changes what the page looks like and nothing about what it
 * accepts or whom it lets in.
 */
export function SignInPanel({
  logoSrc, localAuth,
}: {
  /** The branded logo to show instead of the wordmark, where there is one. */
  logoSrc?: string | null;
  localAuth: boolean;
}) {
  return (
    <main
      id="main"
      className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-spike-50 via-ink-50 to-white px-4 py-12"
    >
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          {logoSrc ? (
            // No alt text and no name: the page is deliberately not a statement
            // about which organisations this product has as customers. The
            // heading below says what the page is for, which is what a screen
            // reader needs here.
            <img
              src={logoSrc}
              alt=""
              className="mx-auto h-10 w-auto max-w-[12rem] object-contain"
            />
          ) : (
            <p className="text-xl"><Wordmark /></p>
          )}
          <p className="mt-2 text-sm text-ink-500">
            {logoSrc
              ? 'Sign in to continue'
              : 'Rental management for South African landlords'}
          </p>
        </div>

        <Card className="p-6">
          <SignInForm />
        </Card>

        <p className="text-center text-sm text-ink-500">
          <a href="/recover" className="font-medium text-spike-600 hover:underline">
            Cannot sign in?
          </a>
        </p>

        <p className="text-center text-sm text-ink-500">
          No account yet?{' '}
          <a href="/request-access" className="font-medium text-spike-600 hover:underline">
            Ask for one
          </a>
          .
        </p>

        {localAuth ? (
          <p className="rounded-lg border border-caution-700/25 bg-caution-50 px-4 py-3 text-xs text-caution-700">
            <strong className="font-semibold">Development authentication.</strong>{' '}
            AUTH_PROVIDER is not set to <code>supabase</code>, so credentials are held in the
            local database rather than by Supabase Auth. Multi-factor authentication IS
            enforced for elevated roles in this mode, but password policy and breach
            detection are not. Account recovery works <em>only</em> in this mode: it resets
            the credentials held in this database, which Supabase Auth does not read. Do not
            use this mode with real customer data.
          </p>
        ) : null}
      </div>
    </main>
  );
}
