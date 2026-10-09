import Link from 'next/link';
import {
  Card, DataTable, EmptyState, Money, PageHeader, StatusBadge, Td, Th,
} from '@propertyos/ui';
import { hasPermission, listDepositAccounts, sumMinor } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { loadLeaseChoices } from '@/lib/operations-queries';
import { RecordDepositForm } from './deposit-forms';

export const metadata = { title: 'Deposits' };
export const dynamic = 'force-dynamic';

const HOLDER_LABEL: Record<string, string> = {
  landlord: 'Landlord',
  agency_trust: 'Agency trust',
  third_party_custodian: 'Custodian',
};

/**
 * Deposits held, as an operational list.
 *
 * A deposit is money held for the resident, not income. It is never netted off
 * the rent receivable, which is why this is its own register rather than a
 * column on a statement.
 *
 * The accountant's version of this — with interest, deductions and refunds
 * broken out and its qualifications attached — is the deposit register under
 * Reports. This one is for doing the work: what is held, what is short, and
 * which deposits need attention.
 */
export default async function DepositsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const context = await requireOperator(org);

  const { accounts, leases, canRecord } = await readAs(context.viewer, async (tx) => ({
    accounts: await listDepositAccounts(tx, context.organisationId),
    leases: await loadLeaseChoices(tx, context.organisationId),
    canRecord: await hasPermission(tx, context.organisationId, 'deposit.record'),
  }));

  const today = new Date().toISOString().slice(0, 10);
  const currency = accounts[0]?.currencyCode ?? context.currencyCode;
  const totalHeld = sumMinor(accounts.map((a) => a.heldMinor));
  const totalShort = sumMinor(accounts.map((a) => a.shortfallMinor));
  const leaseChoices = leases.map((l) => ({ id: l.id, label: `${l.reference} — ${l.label}` }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Deposits"
        description="Money held on behalf of residents, what each lease requires, and anything short."
        actions={
          canRecord ? (
            <RecordDepositForm org={org} leases={leaseChoices} today={today} />
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Total held</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            <Money minor={totalHeld} currency={currency} />
          </p>
          <p className="mt-2 text-sm text-ink-500">
            A liability. It does not reduce any rent receivable.
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Short of required</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            <Money minor={totalShort} currency={currency} emphasise={totalShort > 0n} />
          </p>
          <p className="mt-2 text-sm text-ink-500">
            Not arrears. A deposit shortfall is never billed as rent.
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">Open accounts</p>
          <p className="mt-1 text-3xl font-semibold tracking-tight">
            {accounts.filter((a) => a.status === 'open').length}
          </p>
          <p className="mt-2 text-sm text-ink-500">
            <Link href={`/app/${org}/reports/deposits`} className="text-spike-600 hover:underline">
              The accountant&rsquo;s register →
            </Link>
          </p>
        </Card>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          title="No deposits recorded"
          description="Record a deposit when the money actually arrives. Until then the lease simply shows what it requires."
          action={
            canRecord ? (
              <RecordDepositForm org={org} leases={leaseChoices} today={today} />
            ) : undefined
          }
        />
      ) : (
        <DataTable
          caption="Deposits held"
          head={
            <tr>
              <Th>Resident</Th><Th>Unit</Th><Th>Lease</Th><Th>Held by</Th>
              <Th numeric>Required</Th><Th numeric>Held</Th><Th numeric>Short</Th><Th>Status</Th>
            </tr>
          }
        >
          {accounts.map((a) => (
            <tr key={a.id} className="hover:bg-ink-50">
              <Td>
                <Link
                  href={`/app/${org}/deposits/${a.id}`}
                  className="font-medium text-spike-600 hover:underline"
                >
                  {a.residentName ?? a.leaseReference}
                </Link>
              </Td>
              <Td className="text-ink-500">{a.unitLabel}</Td>
              <Td className="tabular text-ink-500">{a.leaseReference}</Td>
              <Td className="text-ink-500">{HOLDER_LABEL[a.holder] ?? a.holder}</Td>
              <Td numeric><Money minor={a.requiredMinor} currency={a.currencyCode} /></Td>
              <Td numeric><Money minor={a.heldMinor} currency={a.currencyCode} emphasise /></Td>
              <Td numeric>
                <Money
                  minor={a.shortfallMinor} currency={a.currencyCode}
                  emphasise={a.shortfallMinor > 0n}
                />
              </Td>
              <Td>
                <StatusBadge tone={a.status === 'open' ? 'positive' : 'neutral'}>
                  {a.status}
                </StatusBadge>
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}
