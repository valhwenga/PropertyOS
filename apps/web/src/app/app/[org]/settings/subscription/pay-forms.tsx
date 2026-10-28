'use client';

import { useActionState } from 'react';
import { Button, StatusBadge } from '@propertyos/ui';
import { payInvoiceAction } from './actions';

/**
 * Paying an invoice, and what happened to the last attempt.
 *
 * The copy is careful in one specific way: nothing on this screen ever says a
 * payment succeeded on the strength of the payer coming back. An attempt that
 * has not been confirmed by the provider reads as "waiting", because that is
 * all anybody knows at that point.
 */

export interface AttemptView {
  reference: string;
  provider: string;
  status: 'created' | 'pending' | 'confirmed' | 'failed' | 'cancelled';
  createdAt: string;
  amountMinor: number;
  failureReason: string | null;
}

const WAITING = new Set(['created', 'pending']);

export function PayInvoice({
  invoiceId, outstanding, attempts, providerAvailable, providerReason,
}: {
  invoiceId: string;
  outstanding: string;
  attempts: AttemptView[];
  providerAvailable: boolean;
  providerReason?: string | undefined;
}) {
  const [state, action, pending] = useActionState(payInvoiceAction, null);
  const latest = attempts[0];
  const waiting = latest && WAITING.has(latest.status);

  if (!providerAvailable) {
    // No pretend button. The transfer details are on this page already, and a
    // button that cannot work is worse than no button.
    return (
      <p className="text-xs text-ink-500">
        Paying online is not available on this deployment — pay by transfer, quoting the
        invoice number. {providerReason}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {waiting ? (
        <div className="rounded-lg border border-info-700/25 bg-info-50 px-3 py-2">
          <p className="text-sm text-ink-900">
            A payment of {outstanding} is waiting on confirmation from{' '}
            {latest.provider}.
          </p>
          <p className="mt-0.5 text-xs text-ink-500">
            Reference <span className="tabular">{latest.reference}</span>. This invoice is
            marked paid when the provider confirms the money, not when you come back from
            their page — so if you have paid, it may take a minute to show here.
          </p>
        </div>
      ) : null}

      {latest && latest.status === 'failed' ? (
        <p className="text-sm text-critical-700">
          The last attempt ({latest.reference}) did not go through. Nothing was charged.
        </p>
      ) : null}

      {state && !state.ok ? (
        <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{state.message}</p>
        </div>
      ) : null}

      {!waiting ? (
        <form action={action}>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Opening…' : `Pay ${outstanding} now`}
          </Button>
        </form>
      ) : null}

      {attempts.length > 0 ? (
        <ul className="space-y-1">
          {attempts.slice(0, 4).map((attempt) => (
            <li key={attempt.reference} className="flex flex-wrap items-center gap-2 text-xs">
              <StatusBadge
                tone={
                  attempt.status === 'confirmed' ? 'positive'
                    : attempt.status === 'failed' ? 'critical'
                      : attempt.status === 'cancelled' ? 'neutral' : 'info'
                }
                glyph={
                  attempt.status === 'confirmed' ? '●'
                    : attempt.status === 'failed' ? '▲'
                      : attempt.status === 'cancelled' ? '■' : '◐'
                }
              >
                {attempt.status}
              </StatusBadge>
              <span className="tabular text-ink-500">{attempt.reference}</span>
              <span className="text-ink-400">
                {attempt.createdAt.slice(0, 16).replace('T', ' ')} · {attempt.provider}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
