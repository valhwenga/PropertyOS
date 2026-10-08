import Link from 'next/link';
import { Card, EmptyState, PageHeader, StatusBadge } from '@propertyos/ui';
import {
  bankAccountHistory, hasPermission, listBankAccounts, type BankAccountChange,
} from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import {
  ActiveForm, AddBankAccountForm, ChangeNumberForm, EditDetailsForm, VerifyForm,
} from './banking-forms';

export const metadata = { title: 'Banking details' };
export const dynamic = 'force-dynamic';

/** How a history row reads in a sentence. */
const CHANGE_LABEL: Record<BankAccountChange['changeType'], string> = {
  created: 'Account added',
  account_number_changed: 'Account number changed',
  details_changed: 'Details changed',
  verified: 'Verification recorded',
  verification_withdrawn: 'Verification withdrawn',
  deactivated: 'Taken out of use',
  reactivated: 'Put back into use',
};

/**
 * Where the landlord's rent is paid.
 *
 * The screen states three things the product must not be vague about: the
 * number is masked and nothing here can reveal it; the verification says what
 * was actually done rather than the bare word "verified"; and every change is
 * listed with who made it, why, and whether they re-proved their identity.
 */
export default async function BankingPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const context = await requireOperator(org);
  const returnTo = `/app/${org}/settings/banking`;

  const { accounts, history, canManage, canVerify } = await readAs(context.viewer, async (tx) => {
    const list = await listBankAccounts(tx, context.organisationId);
    const entries = await Promise.all(
      list.map(async (a) => [a.id, await bankAccountHistory(tx, context.organisationId, a.id)] as const),
    );
    return {
      accounts: list,
      history: new Map(entries),
      canManage: await hasPermission(tx, context.organisationId, 'bank_account.manage'),
      canVerify: await hasPermission(tx, context.organisationId, 'bank_account.verify'),
    };
  });

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/settings`} className="text-sm text-spike-600 hover:underline">
        ← Settings
      </Link>

      <PageHeader
        title="Banking details"
        description="The accounts residents pay into. Changes need your authenticator code and are recorded permanently."
      />

      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">How these details are held</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-700">
          <li>The full account number is sealed. Only the last four digits are ever shown.</li>
          <li>
            Changing a number clears its verification and asks you to confirm your second factor.
          </li>
          <li>
            Verification records how the details were checked. PropertyOS does not contact any
            bank, so nothing here is confirmed by a bank unless a person recorded that it was.
          </li>
          <li>An account is taken out of use, never deleted, so past records keep resolving.</li>
        </ul>
      </Card>

      {accounts.length === 0 ? (
        <EmptyState
          title="No banking details yet"
          description="Add the account residents pay rent into. It appears on their statements and on generated lease agreements."
          action={canManage ? <AddBankAccountForm org={org} returnTo={returnTo} /> : undefined}
        />
      ) : (
        <>
          {accounts.map((account) => {
            const changes = history.get(account.id) ?? [];
            return (
              <Card key={account.id} className="space-y-5 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-ink-900">{account.label}</h2>
                    <p className="mt-0.5 text-sm text-ink-500">
                      {account.bankName}
                      {account.branchCode ? ` · branch ${account.branchCode}` : ''}
                      {' · '}
                      <span className="tabular">•••• {account.accountNumberLast4}</span>
                    </p>
                    {account.accountHolder ? (
                      <p className="text-sm text-ink-500">Held by {account.accountHolder}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={account.isActive ? 'positive' : 'neutral'}>
                      {account.isActive ? 'in use' : 'out of use'}
                    </StatusBadge>
                    <StatusBadge tone={account.verificationMethod === 'none' ? 'caution' : 'positive'}>
                      {account.accountRole === 'deposit' ? 'deposits' : 'rent'}
                    </StatusBadge>
                  </div>
                </div>

                {/* The verification sentence, in full. Never the bare word. */}
                <div
                  className={`rounded-lg border p-3 text-sm ${
                    account.verificationMethod === 'none'
                      ? 'border-caution-700/30 bg-caution-50 text-caution-700'
                      : 'border-ink-100 bg-ink-50 text-ink-700'
                  }`}
                >
                  <p className="font-medium">{account.verificationLabel}</p>
                  {account.verifiedAt ? (
                    <p className="mt-0.5 text-xs text-ink-500">
                      Recorded {formatDate(account.verifiedAt, context.timeZone)}
                      {account.verificationNote ? ` · ${account.verificationNote}` : ''}
                    </p>
                  ) : null}
                  {!account.hasStoredNumber ? (
                    <p className="mt-0.5 text-xs text-ink-500">
                      Only the last four digits are on file for this account. Agreements that need
                      the full number will show it as missing.
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {canManage ? (
                    <EditDetailsForm org={org} account={account} returnTo={returnTo} />
                  ) : null}
                  {canVerify ? (
                    <VerifyForm org={org} bankAccountId={account.id} returnTo={returnTo} />
                  ) : null}
                  {canManage ? (
                    <ActiveForm
                      org={org} bankAccountId={account.id}
                      active={account.isActive} returnTo={returnTo}
                    />
                  ) : null}
                </div>

                {canManage ? (
                  <ChangeNumberForm
                    org={org} bankAccountId={account.id}
                    last4={account.accountNumberLast4} returnTo={returnTo}
                  />
                ) : null}

                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
                    History
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {changes.map((c) => (
                      <li key={c.id} className="border-l-2 border-ink-100 pl-3 text-sm">
                        <p className="font-medium text-ink-900">
                          {CHANGE_LABEL[c.changeType]}
                          {c.previousLast4 && c.newLast4 ? (
                            <span className="tabular font-normal text-ink-500">
                              {' '}•••• {c.previousLast4} → •••• {c.newLast4}
                            </span>
                          ) : null}
                        </p>
                        <p className="text-ink-700">{c.reason}</p>
                        <p className="text-xs text-ink-400">
                          {c.changedByName ?? 'Unknown user'} ·{' '}
                          {formatDate(c.changedAt, context.timeZone)} ·{' '}
                          {c.freshAuthentication
                            ? 'identity re-confirmed'
                            : 'no re-confirmation required'}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              </Card>
            );
          })}

          {canManage ? <AddBankAccountForm org={org} returnTo={returnTo} /> : null}
        </>
      )}

      {!canManage ? (
        <p className="text-sm text-ink-500">
          You can see these details but not change them. Changing where rent is paid needs the
          banking permission, which is held separately from other settings.
        </p>
      ) : null}
    </div>
  );
}
