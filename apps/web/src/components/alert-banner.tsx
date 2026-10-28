import Link from 'next/link';
import type { PlatformAlert } from '@propertyos/domain';

/**
 * What is wrong, on every page of the console.
 *
 * In the layout rather than on the home page on purpose. The home page already
 * carried the counts and nobody opened it: an operator who is deep in a
 * customer's plan change is exactly the person who needs to be told that the
 * worker has stopped, and a signal that only appears where you were not
 * looking is the signal this product already had.
 *
 * Only critical conditions, and only unsilenced ones. A banner that carries
 * every warning is a banner people learn to read past, which is the failure
 * mode worth designing against rather than the one that looks thorough.
 */
export function AlertBanner({ alerts }: { alerts: PlatformAlert[] }) {
  const shouting = alerts.filter((a) => a.severity === 'critical' && !a.silencedUntil);
  if (shouting.length === 0) return null;

  return (
    <div className="border-b border-critical-700/40 bg-critical-50" role="alert">
      <div className="mx-auto max-w-[80rem] space-y-1 px-4 py-2">
        {shouting.map((alert) => (
          <p key={alert.key} className="text-sm text-critical-700">
            <span aria-hidden="true">▲ </span>
            <span className="font-semibold">{alert.summary}</span>{' '}
            <Link
              href={alert.href}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              Look
            </Link>
            {shouting.length === 1 ? (
              <span className="text-ink-700"> — {alert.detail}</span>
            ) : null}
          </p>
        ))}
        {shouting.length > 1 ? (
          <p className="text-xs text-ink-700">
            <Link href="/platform" className="underline underline-offset-2">
              All of it, and what has been said about it
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
