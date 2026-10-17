import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@propertyos/ui';
import { readAs, requireViewer } from '@/lib/auth';
import { loadTenancy } from '@/lib/portal-queries';
import { todayIn } from '@/lib/today';
import { ProofOfPaymentForm } from './form';

export const metadata = { title: 'Upload proof of payment' };

export default async function PaymentsPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  // Resolved on the server, in the organisation's own time zone, and handed to
  // the form. The form used to call `new Date()` itself: the server rendered
  // the UTC date, the browser re-rendered its local one, and React reported a
  // mismatch it says it will not patch up. The visible half of that bug was
  // worse than the warning — a resident paying at half past midnight was
  // offered yesterday, and the field refuses a date in the future, so it then
  // refused the real one.
  const tenancy = await readAs(viewer, (tx) => loadTenancy(tx, leaseId));
  const today = todayIn(tenancy?.time_zone ?? 'Africa/Johannesburg');

  return (
    <div className="space-y-4">
      <Link href={`/portal/${leaseId}`}
            className="inline-flex min-h-11 items-center text-sm text-spike-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-spike-500">
        ← Back to your account
      </Link>
      <h2 className="text-xl font-semibold tracking-tight text-ink-900">
        Tell us about a payment
      </h2>

      {/* The honesty requirement, stated plainly to the resident BEFORE they
          submit, so nobody believes their balance has been settled. */}
      <Card className="border-info-700/25 bg-info-50 p-4">
        <p className="text-sm font-semibold text-info-700">What happens next</p>
        <p className="mt-1 text-sm text-ink-700">
          This records that you say you have paid. It does <strong>not</strong> change your
          balance. Your landlord will check it against their bank records, and your statement
          will update once the payment is confirmed. If the money has already cleared, it may
          appear before they review this.
        </p>
      </Card>

      <Card className="p-5">
        <ProofOfPaymentForm leaseId={leaseId} today={today} />
      </Card>
    </div>
  );
}
