import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@propertyos/ui';
import { requireViewer } from '@/lib/auth';
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

  return (
    <div className="space-y-4">
      <Link href={`/portal/${leaseId}`} className="text-sm text-spike-600 hover:underline">
        ← Back to your account
      </Link>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">
        Tell us about a payment
      </h1>

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
        <ProofOfPaymentForm leaseId={leaseId} />
      </Card>
    </div>
  );
}
