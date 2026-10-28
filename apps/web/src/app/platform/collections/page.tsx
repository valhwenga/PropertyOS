import { Card, EmptyState, PageHeader } from '@propertyos/ui';
import { formatMoney, listCollections, platformPermissionsOf } from '@propertyos/domain';
import { resolvePaymentProvider } from '@propertyos/integrations';
import { readAs, requireViewer } from '@/lib/auth';
import { CollectionCard, PrepareRunForm, type CollectionRow } from './collection-forms';

export const metadata = { title: 'Debit orders' };
export const dynamic = 'force-dynamic';

/**
 * The debit order run.
 *
 * Ordered by what needs a decision rather than by date: prepared instructions
 * are waiting on a person, unpaid and disputed ones are waiting on a person,
 * and the successful ones are history. A screen sorted by date would bury the
 * two rows that matter under three months of things that worked.
 */
export default async function PlatformCollectionsPage() {
  const viewer = await requireViewer();
  const provider = resolvePaymentProvider();

  const { collections, mine } = await readAs(viewer, async (tx) => ({
    collections: await listCollections(tx, viewer.authUserId),
    mine: await platformPermissionsOf(tx, viewer.authUserId),
  }));

  const canCollect = mine.includes('platform.billing.manage');
  const view = (c: (typeof collections)[number]): CollectionRow => ({
    id: c.id,
    organisationName: c.organisationName,
    invoiceNumber: c.invoiceNumber,
    reference: c.reference,
    amount: formatMoney(c.amountMinor, c.currencyCode),
    amountMinor: c.amountMinor,
    actionDate: c.actionDate,
    status: c.status,
    accountNumberLast4: c.accountNumberLast4,
    providerReference: c.providerReference,
    unpaidReason: c.unpaidReason,
    disputeReason: c.disputeReason,
    abandonedReason: c.abandonedReason,
  });

  const prepared = collections.filter((c) => c.status === 'prepared');
  const needsAttention = collections.filter((c) => c.status === 'unpaid' || c.status === 'disputed');
  const inFlight = collections.filter((c) => c.status === 'submitted');
  const done = collections.filter((c) => c.status === 'successful' || c.status === 'abandoned');

  // The first of next month, which is when most mandates collect.
  const next = new Date();
  next.setUTCMonth(next.getUTCMonth() + 1, 1);
  const defaultDate = next.toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Debit orders"
        description="What Spike will take from customers who authorised it, what the banks said, and what nobody can collect."
      />

      {!provider.available ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">
            Nothing can be submitted on this deployment
          </p>
          <p className="mt-1 text-sm text-ink-700">{provider.unavailableReason}</p>
          <p className="mt-1 text-xs text-ink-500">
            A run can still be prepared, which is how you see what would be collected.
          </p>
        </Card>
      ) : provider.name === 'sandbox' ? (
        <Card className="border-caution-700/25 bg-caution-50 p-4">
          <p className="text-sm font-semibold text-caution-700">Sandbox provider</p>
          <p className="mt-1 text-sm text-ink-700">
            Submitting hands the instruction to a stand-in that moves no money, and its answers
            are produced by hand. Never use this with real customers.
          </p>
        </Card>
      ) : null}

      {canCollect ? <PrepareRunForm defaultDate={defaultDate} /> : null}

      {needsAttention.length > 0 ? (
        <section aria-labelledby="attention" className="space-y-3">
          <h2 id="attention" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            Did not come out
          </h2>
          {needsAttention.map((c) => (
            <CollectionCard key={c.id} collection={view(c)} sandbox={provider.name === 'sandbox'} />
          ))}
        </section>
      ) : null}

      <section aria-labelledby="prepared" className="space-y-3">
        <h2 id="prepared" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Prepared, nothing sent
        </h2>
        {prepared.length === 0 ? (
          <EmptyState
            title="Nothing is waiting to be submitted"
            description="Prepare a run to see what would be collected, and from whom."
          />
        ) : (
          prepared.map((c) => (
            <CollectionCard key={c.id} collection={view(c)} sandbox={provider.name === 'sandbox'} />
          ))
        )}
      </section>

      {inFlight.length > 0 ? (
        <section aria-labelledby="flight" className="space-y-3">
          <h2 id="flight" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
            With the bank
          </h2>
          {inFlight.map((c) => (
            <CollectionCard key={c.id} collection={view(c)} sandbox={provider.name === 'sandbox'} />
          ))}
        </section>
      ) : null}

      {done.length > 0 ? (
        <details className="rounded-lg border border-ink-200 bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium text-ink-700">
            Finished ({done.length})
          </summary>
          <div className="mt-3 space-y-3">
            {done.slice(0, 25).map((c) => (
              <CollectionCard key={c.id} collection={view(c)} sandbox={false} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
