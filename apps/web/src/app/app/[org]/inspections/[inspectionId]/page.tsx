import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, PageHeader, StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { getInspection, hasPermission } from '@propertyos/domain';
import { readAs, requireOperator } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { FindingsForm, FinaliseInspectionForm, ReviseInspectionForm } from '../inspection-forms';

export const metadata = { title: 'Inspection' };
export const dynamic = 'force-dynamic';

const TONE: Record<string, StatusTone> = {
  draft: 'neutral', finalised: 'info', acknowledged: 'positive',
  disputed: 'critical', superseded: 'neutral',
};

/** What the state means, rather than a badge the reader has to interpret. */
const MEANING: Record<string, string> = {
  draft: 'Being filled in. Nothing is fixed yet and the resident has not been asked to respond.',
  finalised: 'Submitted and closed to editing. Awaiting the resident\'s acknowledgement '
    + 'or dispute.',
  acknowledged: 'The resident agreed with the findings.',
  disputed: 'The resident disputed the findings. Their comment stands beside the record '
    + 'without changing it.',
  superseded: 'Corrected by a later version. This one is kept exactly as it was submitted.',
};

const CONDITION_LABEL: Record<string, string> = {
  good: 'Good', fair: 'Fair', poor: 'Poor', damaged: 'Damaged',
  not_applicable: 'Not checked',
};

const CONDITION_TONE: Record<string, StatusTone> = {
  good: 'positive', fair: 'info', poor: 'caution', damaged: 'critical',
  not_applicable: 'neutral',
};

const DAMAGE_LABEL: Record<string, string> = {
  fair_wear_and_tear: 'Fair wear and tear — not deductible',
  damage: 'Damage',
  missing: 'Missing',
};

/**
 * One inspection.
 *
 * A draft is editable; anything else is read-only and corrected by superseding.
 * The page is explicit about which, because the difference is the whole reason
 * an inspection is worth anything in a deposit dispute.
 */
export default async function InspectionPage({
  params,
}: {
  params: Promise<{ org: string; inspectionId: string }>;
}) {
  const { org, inspectionId } = await params;
  const context = await requireOperator(org);

  const data = await readAs(context.viewer, async (tx) => {
    const inspection = await getInspection(tx, context.organisationId, inspectionId);
    if (!inspection) return undefined;
    return {
      inspection,
      canRecord: await hasPermission(tx, context.organisationId, 'inspection.manage'),
    };
  });
  if (!data) notFound();

  const { inspection, canRecord } = data;
  const today = new Date().toISOString().slice(0, 10);
  const isDraft = inspection.status === 'draft';
  const unchecked = inspection.items.filter((i) => i.condition === 'not_applicable').length;
  const deductible = inspection.items.filter(
    (i) => i.damageType === 'damage' || i.damageType === 'missing',
  ).length;

  return (
    <div className="space-y-6">
      <Link href={`/app/${org}/inspections`} className="text-sm text-spike-600 hover:underline">
        ← Inspections
      </Link>

      <PageHeader
        title={`${inspection.propertyName} / ${inspection.unitCode}`}
        description={
          `${inspection.inspectionType.replace(/_/g, ' ')} · ${inspection.templateName} `
          + `v${inspection.templateVersion}`
          + `${inspection.residentName ? ` · ${inspection.residentName}` : ''}`
        }
      />

      <Card className="p-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Scheduled</dt>
            <dd className="mt-1 text-sm text-ink-900">
              {inspection.scheduledFor
                ? formatDate(inspection.scheduledFor, context.timeZone) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Performed</dt>
            <dd className="mt-1 text-sm text-ink-900">
              {inspection.performedOn
                ? formatDate(inspection.performedOn, context.timeZone) : 'Not yet'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Inspector</dt>
            <dd className="mt-1 text-sm text-ink-900">{inspection.inspectorName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Who was present
            </dt>
            <dd className="mt-1 text-sm text-ink-900">{inspection.attendees ?? '—'}</dd>
          </div>
          {inspection.keysHandedOver ? (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Keys</dt>
              <dd className="mt-1 text-sm text-ink-900">{inspection.keysHandedOver}</dd>
            </div>
          ) : null}
          {inspection.leaseReference ? (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Lease</dt>
              <dd className="mt-1 text-sm text-ink-900">
                <Link
                  href={`/app/${org}/leases/${inspection.leaseId}`}
                  className="text-spike-600 hover:underline"
                >
                  {inspection.leaseReference}
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-4 border-t border-ink-100 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={TONE[inspection.status] ?? 'neutral'}>
              {inspection.status}
            </StatusBadge>
            {inspection.finalisedAt ? (
              <span className="text-xs text-ink-500">
                finalised {formatDate(inspection.finalisedAt, context.timeZone)}
              </span>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-ink-700">{MEANING[inspection.status]}</p>
          {inspection.revisionReason ? (
            <p className="mt-2 text-sm text-ink-700">
              <span className="font-medium">Reason for this version:</span>{' '}
              {inspection.revisionReason}
              {inspection.supersedesInspectionId ? (
                <>
                  {' '}
                  <Link
                    href={`/app/${org}/inspections/${inspection.supersedesInspectionId}`}
                    className="text-spike-600 hover:underline"
                  >
                    See the version it replaces →
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </Card>

      {/* ------------------------------------------------------------ findings */}

      {isDraft && canRecord ? (
        <FindingsForm org={org} inspectionId={inspectionId} items={inspection.items} />
      ) : (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-ink-900">Findings</h2>
          <p className="pb-2 text-sm text-ink-500">
            {isDraft
              ? 'Recording findings needs the inspection permission.'
              : 'Closed to editing. A correction creates a new version.'}
          </p>
          {inspection.items.map((i) => (
            <div key={i.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1
              border-t border-ink-100 py-3">
              <span className="text-sm font-medium text-ink-900">{i.item}</span>
              <span className="text-xs uppercase tracking-wide text-ink-400">{i.room}</span>
              <StatusBadge tone={CONDITION_TONE[i.condition] ?? 'neutral'}>
                {CONDITION_LABEL[i.condition] ?? i.condition}
              </StatusBadge>
              {i.damageType ? (
                <span className="text-sm text-ink-700">{DAMAGE_LABEL[i.damageType]}</span>
              ) : null}
              {i.note ? <span className="text-sm text-ink-500">{i.note}</span> : null}
            </div>
          ))}
        </Card>
      )}

      {/* The arithmetic a deposit deduction actually rests on. */}
      {!isDraft ? (
        <Card className="p-4">
          <p className="text-sm text-ink-700">
            {deductible === 0
              ? 'Nothing here is recorded as damage or missing, so this inspection supports no '
                + 'deposit deduction.'
              : `${deductible === 1 ? '1 item is' : `${deductible} items are`} recorded as damage `
                + 'or missing. A deduction against the deposit is still a separate decision and '
                + 'needs its own evidence and approval.'}
            {unchecked > 0
              ? ` ${unchecked === 1 ? '1 item was' : `${unchecked} items were`} not checked.`
              : ''}
          </p>
        </Card>
      ) : null}

      {/* -------------------------------------------- the resident's response */}

      {inspection.responses.length > 0 ? (
        <Card className="p-5">
          <h2 className="pb-2 text-sm font-semibold text-ink-900">The resident&rsquo;s response</h2>
          {inspection.responses.map((r, index) => (
            <div key={`${r.respondedAt}-${index}`} className="border-t border-ink-100 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={r.response === 'disputed' ? 'critical' : 'positive'}>
                  {r.response}
                </StatusBadge>
                <span className="text-xs text-ink-500">
                  {r.residentName ? `${r.residentName} · ` : ''}
                  {formatDate(r.respondedAt, context.timeZone)}
                </span>
              </div>
              {r.comment ? <p className="mt-2 text-sm text-ink-700">{r.comment}</p> : null}
            </div>
          ))}
        </Card>
      ) : null}

      {/* ------------------------------------------------------- what is next */}

      {canRecord ? (
        <div className="space-y-3">
          {isDraft ? (
            <FinaliseInspectionForm
              org={org} inspectionId={inspectionId} today={today} unchecked={unchecked}
            />
          ) : inspection.status === 'superseded' ? null : (
            <ReviseInspectionForm org={org} inspectionId={inspectionId} />
          )}
        </div>
      ) : null}
    </div>
  );
}
