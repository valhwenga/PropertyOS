import { notFound } from 'next/navigation';
import { Button, Card, PageHeader } from '@propertyos/ui';
import { resolvePaymentProvider } from '@propertyos/integrations';
import { Wordmark } from '@/components/wordmark';
import { sandboxDecideAction } from './actions';

export const metadata = { title: 'Development payment page' };
export const dynamic = 'force-dynamic';

/**
 * A payment page that is not one.
 *
 * It stands in for a provider's hosted page so that the whole collection path
 * can be exercised — in the preview and in the browser tests — with no
 * merchant account anywhere. It is loud about what it is, because a page that
 * looks like a checkout and takes no money is the single most dangerous screen
 * to leave ambiguous.
 *
 * It exists only when SUBSCRIPTION_PAYMENT_PROVIDER is `sandbox`. On any other
 * deployment it is a 404, not a hidden page.
 */
export default async function SandboxPaymentPage({
  params, searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ amount?: string; currency?: string; description?: string }>;
}) {
  const provider = resolvePaymentProvider();
  if (provider.name !== 'sandbox' || !provider.available) notFound();

  const { reference } = await params;
  const query = await searchParams;
  const amountMinor = query.amount ?? '0';
  const major = (Number(amountMinor) / 100).toFixed(2);

  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>

      <div className="mb-6 rounded-lg border-2 border-caution-700/40 bg-caution-50 px-4 py-3">
        <p className="text-sm font-semibold text-caution-700">
          This is not a payment page.
        </p>
        <p className="mt-1 text-sm text-ink-700">
          No card is taken and no money moves. It stands where a real provider&rsquo;s page
          stands so the rest of the path can be tested, and it exists only because this
          deployment is configured with the sandbox provider.
        </p>
      </div>

      <PageHeader
        title={`Pay R${major}`}
        description={query.description ?? 'A PropertyOS subscription invoice.'}
      />

      <Card className="mt-6 space-y-4 p-5">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-500">Reference</dt>
            <dd className="tabular text-ink-900">{reference}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Amount</dt>
            <dd className="tabular text-ink-900">R{major} {query.currency ?? 'ZAR'}</dd>
          </div>
        </dl>

        <p className="text-xs text-ink-500">
          Each button signs a notification and posts it to this product&rsquo;s own
          notification endpoint, exactly as a provider&rsquo;s servers would — including the
          signature, so the verification path is the real one.
        </p>

        <div className="flex flex-wrap gap-2">
          {([
            ['confirmed', 'Pay it', 'primary'],
            ['failed', 'Decline it', 'danger'],
            ['cancelled', 'Cancel', 'secondary'],
          ] as const).map(([status, label, variant]) => (
            <form key={status} action={sandboxDecideAction}>
              <input type="hidden" name="reference" value={reference} />
              <input type="hidden" name="status" value={status} />
              <input type="hidden" name="amountMinor" value={amountMinor} />
              <Button type="submit" variant={variant}>{label}</Button>
            </form>
          ))}
        </div>

        <p className="text-xs text-ink-500">
          You can also pay less than the full amount to see a short payment handled:
        </p>
        <form action={sandboxDecideAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="reference" value={reference} />
          <input type="hidden" name="status" value="confirmed" />
          <div>
            <label className="block text-xs font-medium text-ink-700" htmlFor="partial">
              Pay this many cents
            </label>
            <input
              id="partial" name="amountMinor" type="number" min="1" max={amountMinor}
              defaultValue={Math.max(1, Math.floor(Number(amountMinor) / 2))}
              className="mt-1 w-40 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm"
            />
          </div>
          <Button type="submit" variant="secondary">Pay part of it</Button>
        </form>
      </Card>
    </main>
  );
}
