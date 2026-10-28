import { notFound, redirect } from 'next/navigation';
import { Button, Card, PageHeader } from '@propertyos/ui';
import { resolvePaymentProvider } from '@propertyos/integrations';
import { requireViewer } from '@/lib/auth';
import { Wordmark } from '@/components/wordmark';
import { sandboxCollectionDecideAction } from './actions';

export const metadata = { title: 'Development bank response' };
export const dynamic = 'force-dynamic';

/**
 * A bank answering a debit order, which this is not.
 *
 * In the real thing nobody opens a page: the answer arrives days later through
 * the notification endpoint, and sometimes it is a dispute weeks after the
 * money moved. This exists so that path can be exercised, and it is for
 * operators only — a customer has no business deciding whether their own debit
 * succeeded.
 */
export default async function SandboxCollectionPage({
  params, searchParams,
}: {
  params: Promise<{ reference: string }>;
  searchParams: Promise<{ amount?: string }>;
}) {
  const provider = resolvePaymentProvider();
  if (provider.name !== 'sandbox' || !provider.available) notFound();

  const viewer = await requireViewer();
  if (!viewer.isPlatformOperator) redirect('/app');

  const { reference } = await params;
  const { amount } = await searchParams;
  const major = (Number(amount ?? '0') / 100).toFixed(2);

  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>

      <div className="mb-6 rounded-lg border-2 border-caution-700/40 bg-caution-50 px-4 py-3">
        <p className="text-sm font-semibold text-caution-700">This is not a bank.</p>
        <p className="mt-1 text-sm text-ink-700">
          A real answer to a debit order arrives days after it is submitted, by itself, and a
          dispute can arrive weeks after the money moved. This page produces one of those
          answers so the path can be tested, and exists only because this deployment is
          configured with the sandbox provider.
        </p>
      </div>

      <PageHeader
        title={`Answer for ${reference}`}
        description={`A debit order of R${major} was submitted.`}
      />

      <Card className="mt-6 space-y-3 p-5">
        <div className="flex flex-wrap gap-2">
          {([
            ['successful', 'The money came out', 'primary'],
            ['unpaid', 'Insufficient funds', 'danger'],
            ['disputed', 'The payer disputed it', 'secondary'],
          ] as const).map(([status, label, variant]) => (
            <form key={status} action={sandboxCollectionDecideAction}>
              <input type="hidden" name="reference" value={reference} />
              <input type="hidden" name="status" value={status} />
              <input type="hidden" name="amountMinor" value={amount ?? '0'} />
              <Button type="submit" variant={variant}>{label}</Button>
            </form>
          ))}
        </div>
        <p className="text-xs text-ink-500">
          Each posts a signed notification to this product&rsquo;s own endpoint. A dispute
          after a success reverses the settlement, because the money never really arrived.
        </p>
      </Card>
    </main>
  );
}
