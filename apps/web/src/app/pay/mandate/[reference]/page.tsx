import Link from 'next/link';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import { privilegedSql } from '@propertyos/db/client';
import { Wordmark } from '@/components/wordmark';

export const metadata = { title: 'Debit order' };
export const dynamic = 'force-dynamic';

/**
 * Where a payer comes back to after their bank.
 *
 * The same discipline as the payment return page, and for the same reason:
 * coming back here is not evidence that a bank authorised anything. It reports
 * the recorded status, which immediately after a real authorisation is usually
 * still `requested`.
 *
 * It reads by reference on the privileged connection — the payer may be on a
 * device with no session — and shows a status and nothing else about the
 * account.
 */
export default async function MandateReturnPage({
  params,
}: {
  params: Promise<{ reference: string }>;
}) {
  const { reference } = await params;

  const sql = privilegedSql();
  const [mandate] = await sql<{ status: string; day: number }[]>`
    select status, collection_day as day from subscription_mandates
    where reference = ${reference}
  `;

  return (
    <main id="main" className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8"><Wordmark /></div>

      {!mandate ? (
        <PageHeader
          title="We have no record of that"
          description="The reference does not match a mandate. Nothing has been authorised."
        />
      ) : mandate.status === 'authenticated' ? (
        <>
          <PageHeader
            title="Authorised"
            description="Your bank confirmed the debit order."
          />
          <Card className="mt-6 p-5 text-sm text-ink-700">
            <p>
              Spike will collect each month on the day you approved, up to the amount you
              approved and no more. You can cancel it from your subscription settings, or with
              your own bank, at any time.
            </p>
          </Card>
        </>
      ) : mandate.status === 'requested' ? (
        <>
          <PageHeader
            title="Waiting for your bank"
            description="Nothing has been authorised yet, and nothing will be collected."
          />
          <Card className="mt-6 space-y-2 p-5 text-sm text-ink-700">
            <StatusBadge tone="info" glyph="◐">waiting</StatusBadge>
            <p>
              Coming back from your bank does not prove the authority exists, so this will not
              say authorised until your bank tells Spike directly. That usually takes seconds.
            </p>
          </Card>
        </>
      ) : (
        <>
          <PageHeader
            title={mandate.status === 'rejected' ? 'Not authorised' : 'No longer active'}
            description="Nothing will be collected from your account."
          />
          <Card className="mt-6 p-5 text-sm text-ink-700">
            <p>
              You can set up another from your subscription settings, or pay each invoice by
              transfer.
            </p>
          </Card>
        </>
      )}

      <p className="mt-6 text-sm">
        <Link href="/app" className="text-spike-600 underline underline-offset-2">
          Back to PropertyOS
        </Link>
      </p>
    </main>
  );
}
