import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card } from '@propertyos/ui';
import { requireViewer } from '@/lib/auth';
import { MaintenanceRequestForm } from './form';

export const metadata = { title: 'Report a problem' };

export default async function NewRequestPage({
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
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Report a problem</h1>

      {/* An honest statement about emergencies, as the blueprint requires: a
          portal ticket is not a guarantee of emergency response. */}
      <Card className="border-caution-700/25 bg-caution-50 p-4">
        <p className="text-sm font-semibold text-caution-700">If this is an emergency</p>
        <p className="mt-1 text-sm text-ink-700">
          Logging a request here does <strong>not</strong> guarantee an emergency response.
          For a burst pipe, electrical danger, fire or a security risk, use the emergency
          contact details on your lease agreement as well as submitting this form.
        </p>
      </Card>

      <Card className="p-5">
        <MaintenanceRequestForm leaseId={leaseId} />
      </Card>
    </div>
  );
}
