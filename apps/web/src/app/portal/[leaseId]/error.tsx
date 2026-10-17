'use client';

import Link from 'next/link';
import { ErrorState } from '@propertyos/ui';

/**
 * When a section of the tenancy cannot be built.
 *
 * A resident gets a plain sentence and a way onwards, never a stack trace. The
 * digest is the only thing worth quoting to a landlord who asks their support
 * desk what happened.
 */
export default function TenancyError({
  error, reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="space-y-4">
      <ErrorState
        title="This part of your tenancy could not be loaded"
        detail="Nothing has changed on your account. Try again, and tell your landlord if it keeps happening."
        correlationId={error.digest}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="min-h-11 rounded-lg bg-spike-500 px-4 text-sm font-medium text-white hover:bg-spike-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
        >
          Try again
        </button>
        <Link
          href="/portal"
          className="min-h-11 rounded-lg border border-ink-200 bg-surface px-4 py-2.5 text-sm font-medium text-ink-700 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500"
        >
          Your tenancies
        </Link>
      </div>
    </div>
  );
}
