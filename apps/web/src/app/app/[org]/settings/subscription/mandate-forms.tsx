'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import { cancelMandateAction, requestMandateAction } from './actions';

/**
 * The debit order authority, from the payer's side.
 *
 * Two things this screen is careful about, both of them because it is an
 * authorisation rather than a setting.
 *
 * It states the cap in the same breath as asking for it. "Spike may collect up
 * to R X on day N" is the sentence a payer is agreeing to, so it is the
 * sentence on the button rather than a number in a field labelled Amount.
 *
 * And it never says a mandate is active because the payer came back from
 * their bank. Until the provider confirms the authentication, it reads as
 * waiting — the same discipline the payment screen follows.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';

export interface MandateView {
  id: string;
  reference: string;
  status: 'requested' | 'authenticated' | 'suspended' | 'cancelled' | 'rejected';
  authorisedAmount: string;
  collectionDay: number;
  firstCollectionOn: string;
  bankName: string;
  accountNumberLast4: string;
  accountType: string;
  authenticatedAt: string | null;
  rejectionReason: string | null;
  cancellationReason: string | null;
  cancelledByPayer: boolean | null;
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return `${day}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][day % 10] ?? 'th';
  return `${day}${suffix}`;
}

export function MandatePanel({
  slug, organisationId, live, history, providerAvailable, providerReason, suggestedAmount,
}: {
  slug: string;
  organisationId: string;
  live: MandateView | null;
  history: MandateView[];
  providerAvailable: boolean;
  providerReason?: string | undefined;
  suggestedAmount: string;
}) {
  const [requested, request, requesting] = useActionState(requestMandateAction, null);
  const [cancelled, cancel, cancelling] = useActionState(cancelMandateAction, null);
  const [open, setOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const settled = history.filter((m) => m.status === 'cancelled' || m.status === 'rejected');

  return (
    <Card className="space-y-3 p-5" data-mandate-panel>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-900">Pay by debit order</h2>
        {live ? (
          <StatusBadge
            tone={live.status === 'authenticated' ? 'positive' : 'caution'}
            glyph={live.status === 'authenticated' ? '●' : '◐'}
          >
            {live.status === 'authenticated' ? 'active' : 'waiting for your bank'}
          </StatusBadge>
        ) : null}
      </div>

      {!providerAvailable ? (
        <p className="text-xs text-ink-500">
          Not available on this deployment — pay each invoice by transfer, quoting the invoice
          number. {providerReason}
        </p>
      ) : live ? (
        <>
          <p className="text-sm text-ink-700">
            {live.status === 'authenticated' ? 'You have authorised' : 'You have asked your bank to authorise'}{' '}
            Spike to collect up to{' '}
            <strong className="font-medium text-ink-900">{live.authorisedAmount}</strong> on the{' '}
            <strong className="font-medium text-ink-900">{ordinal(live.collectionDay)}</strong> of
            each month, from your {live.bankName} {live.accountType} account ending{' '}
            <span className="tabular">{live.accountNumberLast4}</span>, from{' '}
            {live.firstCollectionOn}.
          </p>

          {live.status === 'requested' ? (
            <p className="rounded-lg border border-info-700/25 bg-info-50 px-3 py-2 text-sm text-ink-700">
              Waiting for your bank. Nothing will be collected until they confirm it — and this
              will not say active because you came back from their page, only when they tell
              Spike directly.
            </p>
          ) : null}

          <p className="text-xs text-ink-500">
            Reference <span className="tabular">{live.reference}</span>
            {live.authenticatedAt ? ` · authorised ${live.authenticatedAt.slice(0, 10)}` : ''}
          </p>

          <p className="text-xs text-ink-500">
            The amount, the day and the account cannot be edited: that is what you authorised.
            To change any of them, cancel this and set up another — your bank will ask you to
            authorise the new one.
          </p>

          {cancelled && !cancelled.ok ? (
            <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
              <p className="text-sm text-critical-700">{cancelled.message}</p>
            </div>
          ) : null}

          <div className="border-t border-ink-100 pt-3">
            <button
              type="button" onClick={() => setCancelOpen((shown) => !shown)}
              className="text-sm font-medium text-ink-600 hover:underline"
            >
              {cancelOpen ? 'Keep it' : 'Cancel this mandate'}
            </button>
            {cancelOpen ? (
              <form action={cancel} className="mt-2 space-y-2">
                <input type="hidden" name="mandateId" value={live.id} />
                <input type="hidden" name="slug" value={slug} />
                <p className="text-xs text-ink-500">
                  Spike stops collecting from this account. Any invoice already owing stays
                  owing, and you can pay it or set up another mandate. You can also cancel a
                  debit order directly with your own bank at any time.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-60 flex-1">
                    <label className="block text-sm font-medium text-ink-700" htmlFor="cancelReason">
                      Why
                    </label>
                    <input
                      id="cancelReason" name="reason" required minLength={5} maxLength={500}
                      placeholder="Changing to the new business account"
                      className={`mt-1 ${FIELD}`}
                    />
                  </div>
                  <Button type="submit" variant="danger" disabled={cancelling}>
                    {cancelling ? 'Cancelling…' : 'Cancel it'}
                  </Button>
                </div>
              </form>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-700">
            Authorise Spike to collect its monthly subscription from your bank account, so
            nobody has to remember to pay each invoice. You set the most that may ever be
            collected, and your own bank asks you to approve it.
          </p>

          {requested && !requested.ok ? (
            <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
              <p className="text-sm text-critical-700">{requested.message}</p>
            </div>
          ) : null}

          <button
            type="button" onClick={() => setOpen((shown) => !shown)}
            className="text-sm font-medium text-spike-600 hover:underline"
          >
            {open ? 'Not now' : 'Set up a debit order'}
          </button>

          {open ? (
            <form action={request} className="space-y-3 border-t border-ink-100 pt-3">
              <input type="hidden" name="organisationId" value={organisationId} />
              <input type="hidden" name="currencyCode" value="ZAR" />

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="authorisedAmount">
                    The most that may be collected
                  </label>
                  <input
                    id="authorisedAmount" name="authorisedAmount" required
                    defaultValue={suggestedAmount} inputMode="decimal"
                    className={`mt-1 ${FIELD}`}
                  />
                  <p className="mt-1 text-xs text-ink-500">
                    A ceiling, not a charge. Spike may never collect more than this, so leave
                    room for growth — your invoice is what it is.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="collectionDay">
                    Day of the month
                  </label>
                  <select id="collectionDay" name="collectionDay" defaultValue="1" className={`mt-1 ${FIELD}`}>
                    {[1, 15, 25, 28].map((day) => (
                      <option key={day} value={day}>{ordinal(day)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="firstCollectionOn">
                    First collection on
                  </label>
                  <input
                    id="firstCollectionOn" name="firstCollectionOn" type="date" required
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="accountHolder">
                    Account holder
                  </label>
                  <input
                    id="accountHolder" name="accountHolder" required maxLength={120}
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="bankName">
                    Bank
                  </label>
                  <input id="bankName" name="bankName" required maxLength={80} className={`mt-1 ${FIELD}`} />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="branchCode">
                    Branch code
                  </label>
                  <input
                    id="branchCode" name="branchCode" required inputMode="numeric"
                    pattern="[0-9]{6}" placeholder="051001" className={`mt-1 ${FIELD}`}
                  />
                  <p className="mt-1 text-xs text-ink-500">Six digits — your bank&rsquo;s universal branch code.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="accountType">
                    Account type
                  </label>
                  <select id="accountType" name="accountType" defaultValue="cheque" className={`mt-1 ${FIELD}`}>
                    <option value="cheque">Cheque / current</option>
                    <option value="savings">Savings</option>
                    <option value="transmission">Transmission</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink-700" htmlFor="accountNumber">
                    Account number
                  </label>
                  <input
                    id="accountNumber" name="accountNumber" required inputMode="numeric"
                    pattern="[0-9]{6,11}" autoComplete="off" className={`mt-1 ${FIELD}`}
                  />
                  <p className="mt-1 text-xs text-ink-500">
                    Stored encrypted. Only the last four digits are ever shown again.
                  </p>
                </div>
              </div>

              <Button type="submit" variant="primary" disabled={requesting}>
                {requesting ? 'Opening…' : 'Authorise with my bank'}
              </Button>
              <p className="text-xs text-ink-500">
                Your bank asks you to approve this. Nothing is collected until they do, and you
                can cancel it here or with your bank at any time.
              </p>
            </form>
          ) : null}
        </>
      )}

      {settled.length > 0 ? (
        <details className="border-t border-ink-100 pt-3">
          <summary className="cursor-pointer text-xs font-medium text-ink-500">
            Earlier mandates ({settled.length})
          </summary>
          <ul className="mt-2 space-y-1">
            {settled.map((m) => (
              <li key={m.reference} className="text-xs text-ink-500">
                <span className="tabular">{m.reference}</span> · {m.status}
                {m.cancelledByPayer === true ? ' (by you)' : ''}
                {m.cancellationReason ? ` — ${m.cancellationReason}` : ''}
                {m.rejectionReason ? ` — ${m.rejectionReason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
  );
}
