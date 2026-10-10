import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Money, PageHeader, StatusBadge } from '@propertyos/ui';
import {
  formatMoney, getDepositAccount, hasPermission, listPayoutRequests,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { loadColleagues, loadLeaseEvidenceChoices } from '@/lib/operations-queries';
import {
  ApprovePayoutForm, CloseDepositForm, CreditInterestForm, DecidePayoutRequestForms,
  RequestPayoutForm,
} from '../deposit-forms';

export const metadata = { title: 'Deposit' };
export const dynamic = 'force-dynamic';

const EVENT_LABEL: Record<string, string> = {
  received: 'Received',
  interest_credited: 'Interest credited',
  deduction: 'Deducted',
  refund: 'Refunded',
  transfer_to_rent: 'Transferred to rent',
  adjustment: 'Adjustment',
};

/**
 * One deposit: what is held, how it got there, and what left.
 *
 * The page is built around the fact that this is somebody else's money. Every
 * movement out of it names the person who asked, the person who approved, the
 * evidence, and the reason — because that combination is what makes a deduction
 * defensible, and its absence is what makes one indefensible.
 */
export default async function DepositPage({
  params,
}: {
  params: Promise<{ org: string; depositAccountId: string }>;
}) {
  const { org, depositAccountId } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => {
    const account = await getDepositAccount(tx, context.organisationId, depositAccountId);
    if (!account) return undefined;
    return {
      account,
      evidence: await loadLeaseEvidenceChoices(tx, context.organisationId, account.leaseId),
      colleagues: await loadColleagues(tx, context.organisationId),
      requests: await listPayoutRequests(tx, context.organisationId, { depositAccountId }),
      canRecord: await hasPermission(tx, context.organisationId, 'deposit.record'),
      canApprove: await hasPermission(tx, context.organisationId, 'deposit.refund.approve'),
    };
  });
  if (!data) notFound();

  const { account, evidence, colleagues, requests, canRecord, canApprove } = data;
  const pendingRequests = requests.filter((r) => r.status === 'pending');
  const decidedRequests = requests.filter((r) => r.status !== 'pending');
  const today = new Date().toISOString().slice(0, 10);
  const evidenceChoices = evidence.map((d) => ({
    id: d.id,
    label: `${d.title} — ${formatDate(d.uploaded_at, context.timeZone)}`,
  }));
  const colleagueChoices = colleagues.map((c) => ({ id: c.auth_user_id, label: c.full_name }));

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/deposits`} className="text-sm text-spike-600 hover:underline">
        ← Deposits
      </Link>

      <PageHeader
        title={`Deposit · ${account.leaseReference}`}
        description={
          `${account.residentName ?? 'No resident on file'} · ${account.unitLabel} · `
          + `opened ${formatDate(account.openedOn, context.timeZone)}`
        }
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm text-info-700">
          This money belongs to the resident. It is not rental income, it never reduces what they
          owe, and PropertyOS does not decide which deductions are lawful — that is for the lease
          and the Rental Housing Act, reviewed by someone qualified to read them.
        </p>
      </Card>

      <Card className="p-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Held now</dt>
            <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
              <Money minor={account.heldMinor} currency={account.currencyCode} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Required by the lease
            </dt>
            <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
              <Money minor={account.requiredMinor} currency={account.currencyCode} />
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Shortfall</dt>
            <dd className="tabular mt-1 text-lg font-semibold text-ink-900">
              <Money
                minor={account.shortfallMinor} currency={account.currencyCode}
                emphasise={account.shortfallMinor > 0n}
              />
            </dd>
            {account.shortfallMinor > 0n ? (
              <dd className="mt-0.5 text-xs text-caution-700">
                Less is held than the lease requires. This is not arrears and must not be billed
                as rent.
              </dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Held by</dt>
            <dd className="mt-1 text-sm text-ink-900">{account.holderLabel}</dd>
            {account.bankReference ? (
              <dd className="text-xs text-ink-400">{account.bankReference}</dd>
            ) : null}
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusBadge tone={account.status === 'open' ? 'positive' : 'neutral'}>
            {account.status}
          </StatusBadge>
          {account.interestBasis ? (
            <span className="text-xs text-ink-500">
              Interest recorded from{' '}
              {account.interestBasis === 'bank_statement_evidence'
                ? 'bank statements'
                : 'an agreed, reviewed calculation'}
            </span>
          ) : (
            <span className="text-xs text-ink-500">
              No interest has been credited. PropertyOS does not accrue any.
            </span>
          )}
          {account.closedOn ? (
            <span className="text-xs text-ink-500">
              Closed {formatDate(account.closedOn, context.timeZone)}
            </span>
          ) : null}
        </div>
      </Card>

      {account.status === 'open' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {canRecord ? (
              <CreditInterestForm
                org={org} depositAccountId={depositAccountId}
                evidence={evidenceChoices} today={today}
              />
            ) : null}
            {canApprove && account.heldMinor === 0n ? (
              <CloseDepositForm org={org} depositAccountId={depositAccountId} today={today} />
            ) : null}
          </div>

          {/* Requests waiting for a decision.

              The approvals queue used to list deposit movements "awaiting
              approval" by reading deposit_events where approved_at is null — a
              row the database forbids, so the section could never show
              anything and there was no way to prepare a payout for somebody
              else to approve. A request lives in its own table and holds
              nothing until it is approved. */}
          {pendingRequests.length > 0 ? (
            <Card className="p-5">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                Waiting for a decision
              </h2>
              <p className="mt-1 text-sm text-ink-500">
                None of this has moved. {formatMoney(account.heldMinor, account.currencyCode)}{' '}
                is still held.
              </p>
              <ul className="mt-4 space-y-4">
                {pendingRequests.map((r) => (
                  <li key={r.id} className="border-t border-ink-100 pt-4">
                    <p className="text-sm font-medium text-ink-900">
                      {formatMoney(r.amountMinor, r.currencyCode)}{' '}
                      <span className="font-normal capitalize text-ink-500">
                        {r.kind.replace(/_/g, ' ')}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-ink-700">{r.description}</p>
                    <p className="mt-1 text-xs text-ink-500">
                      requested by {r.requestedByName ?? 'a colleague'} on{' '}
                      {formatDate(r.requestedAt, context.timeZone)}
                      {r.evidenceTitle ? ` · evidence: ${r.evidenceTitle}` : ''}
                    </p>
                    <div className="mt-3">
                      <DecidePayoutRequestForms
                        org={org} depositAccountId={depositAccountId}
                        canApprove={canApprove}
                        isMine={r.requestedBy === context.viewer.authUserId}
                        request={{
                          id: r.id, kind: r.kind,
                          amountLabel: formatMoney(r.amountMinor, r.currencyCode),
                          description: r.description,
                          requestedByName: r.requestedByName,
                          evidenceTitle: r.evidenceTitle,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {canRecord ? (
            <RequestPayoutForm
              org={org} depositAccountId={depositAccountId}
              evidence={evidenceChoices} today={today}
              heldLabel={formatMoney(account.heldMinor, account.currencyCode)}
            />
          ) : null}

          {canApprove ? (
            <ApprovePayoutForm
              org={org} depositAccountId={depositAccountId}
              evidence={evidenceChoices} colleagues={colleagueChoices} today={today}
              heldLabel={formatMoney(account.heldMinor, account.currencyCode)}
            />
          ) : (
            <Card className="p-4">
              <p className="text-sm text-ink-700">
                You can see this deposit but cannot deduct from or refund it. That needs the
                deposit approval permission, which is held separately — and never by the person
                who requested the payout.
              </p>
            </Card>
          )}
        </div>
      ) : null}

      {decidedRequests.length > 0 ? (
        <Card className="p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Requests already decided
          </h2>
          <p className="mt-1 text-sm text-ink-500">
            A declined or withdrawn request is part of the record of what was asked for. Only
            the approved ones appear as movements below.
          </p>
          <ul className="mt-3 space-y-3">
            {decidedRequests.map((r) => (
              <li key={r.id} className="border-t border-ink-100 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink-900">
                    {formatMoney(r.amountMinor, r.currencyCode)}
                  </span>
                  <StatusBadge
                    tone={r.status === 'approved' ? 'positive'
                      : r.status === 'declined' ? 'critical' : 'neutral'}
                  >
                    {r.status}
                  </StatusBadge>
                  <span className="text-xs text-ink-500">
                    {r.description} · requested by {r.requestedByName ?? 'a colleague'}
                    {r.status === 'withdrawn'
                      ? ' · withdrawn by the requester'
                      : r.decidedByName ? ` · decided by ${r.decidedByName}` : ''}
                  </span>
                </div>
                {r.decisionReason ? (
                  <p className="mt-1 text-sm text-ink-700">{r.decisionReason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Every movement
        </h2>
        {account.events.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Nothing has moved on this deposit yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {account.events.map((e) => (
              <li
                key={e.id}
                className={`border-l-2 pl-3 text-sm ${
                  e.amountMinor < 0n ? 'border-caution-700/40' : 'border-positive-600/40'
                }`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-ink-900">
                    {EVENT_LABEL[e.eventType] ?? e.eventType}
                  </span>
                  <span className="tabular font-medium">
                    <Money minor={e.amountMinor} currency={account.currencyCode} />
                  </span>
                </div>
                <p className="text-ink-700">{e.description}</p>
                <p className="text-xs text-ink-400">
                  {formatDate(e.effectiveOn, context.timeZone)}
                  {e.requestedByName ? ` · requested by ${e.requestedByName}` : ''}
                  {e.approvedByName ? ` · approved by ${e.approvedByName}` : ''}
                  {e.refundReference ? ` · ${e.refundReference}` : ''}
                </p>
                {e.approvalReason ? (
                  <p className="text-xs text-ink-500">{e.approvalReason}</p>
                ) : null}
                {e.evidenceDocumentId ? (
                  <Link
                    href={`/app/${org}/documents/${e.evidenceDocumentId}`}
                    className="text-xs font-medium text-spike-600 hover:underline"
                  >
                    Evidence →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-400">
          Entries are append-only. A mistake is corrected with a further entry, never by editing
          or removing one.
        </p>
      </Card>
    </div>
  );
}
