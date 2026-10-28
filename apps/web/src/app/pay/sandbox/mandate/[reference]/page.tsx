import { notFound } from 'next/navigation';
import { Button, Card, PageHeader } from '@propertyos/ui';
import { resolvePaymentProvider } from '@propertyos/integrations';
import { Wordmark } from '@/components/wordmark';
import { sandboxMandateDecideAction } from './actions';

export const metadata = { title: 'Development authorisation page' };
export const dynamic = 'force-dynamic';

/**
 * A bank's authorisation screen that is not one.
 *
 * Under DebiCheck the real thing happens inside the payer's own banking app:
 * they are shown the amount, the day and the beneficiary, and they approve it
 * there. Nothing in this product can imitate that, and a page pretending to
 * would be teaching everybody who sees it the wrong idea of what authority is.
 *
 * So this says plainly what it stands for, and exists only when the sandbox
 * provider is configured.
 */
export default async function SandboxMandatePage({
  params, searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ amount?: string; day?: string; account?: string }>;
}) {
  const provider = resolvePaymentProvider();
  if (provider.name !== 'sandbox' || !provider.available) notFound();

  const { reference } = await params;
  const query = await searchParams;
  const major = (Number(query.amount ?? '0') / 100).toFixed(2);

  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>

      <div className="mb-6 rounded-lg border-2 border-caution-700/40 bg-caution-50 px-4 py-3">
        <p className="text-sm font-semibold text-caution-700">
          This is not your bank.
        </p>
        <p className="mt-1 text-sm text-ink-700">
          A real debit order mandate is approved by the account holder inside their own
          banking app, which is the whole point of it. This page stands in for that so the
          rest of the path can be tested, and it exists only because this deployment is
          configured with the sandbox provider.
        </p>
      </div>

      <PageHeader
        title="Approve a debit order"
        description="What the account holder would be shown by their bank."
      />

      <Card className="mt-6 space-y-4 p-5">
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-500">Beneficiary</dt>
            <dd className="text-ink-900">Spike PropertyOS</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Up to</dt>
            <dd className="tabular text-ink-900">R{major} each month</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">On day</dt>
            <dd className="tabular text-ink-900">{query.day ?? '1'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Account ending</dt>
            <dd className="tabular text-ink-900">{query.account ?? '----'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-500">Reference</dt>
            <dd className="tabular text-ink-900">{reference}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          {([
            ['authenticated', 'Approve it', 'primary'],
            ['rejected', 'Decline it', 'danger'],
            ['cancelled', 'Withdraw an existing one', 'secondary'],
          ] as const).map(([status, label, variant]) => (
            <form key={status} action={sandboxMandateDecideAction}>
              <input type="hidden" name="reference" value={reference} />
              <input type="hidden" name="status" value={status} />
              <Button type="submit" variant={variant}>{label}</Button>
            </form>
          ))}
        </div>
      </Card>
    </main>
  );
}
