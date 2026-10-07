import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Wordmark } from '@/components/wordmark';
import { requireViewer } from '@/lib/auth';

/**
 * Spike platform administration shell.
 *
 * Being a platform operator admits you to THIS console. It does not admit you to
 * any customer's records: that needs a support session the customer authorised,
 * which is time limited, read-only and audited.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();
  if (!viewer.isPlatformOperator) redirect('/app');

  return (
    <div className="min-h-dvh bg-chrome-900">
      {/* A visually distinct chrome, so an operator always knows they are in the
          platform console rather than inside a customer's account. */}
      <header className="border-b border-white/10 bg-chrome-900 text-white">
        <div className="mx-auto flex max-w-[80rem] items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href="/platform" className="text-base text-white">
              <span className="font-semibold tracking-tight">
                <span className="text-spike-300">Spike</span> Platform
              </span>
            </Link>
            <span className="rounded-full bg-spike-500/20 px-2 py-0.5 text-xs font-medium text-spike-200">
              Internal
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-white/70 sm:inline">{viewer.fullName}</span>
            <Link href="/app" className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white/90">
              Customer view
            </Link>
            <form action="/sign-out" method="post">
              <button type="submit" className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white/90">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-[80rem] px-4 py-6">
        <div className="rounded-[var(--radius-card)] bg-ink-50 p-6">{children}</div>
      </main>
      <footer className="mx-auto max-w-[80rem] px-4 pb-8 text-xs text-white/50">
        <Wordmark compact /> · Customer records are reachable only through an authorised,
        time-limited, audited support session.
      </footer>
    </div>
  );
}
