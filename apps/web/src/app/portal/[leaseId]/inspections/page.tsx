import { notFound } from 'next/navigation';
import { Card, StatusBadge } from '@propertyos/ui';
import type { StatusTone } from '@propertyos/ui';
import { residentInspections } from '@propertyos/domain';
import { readAs, requireViewer } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import { SectionHeading } from '../section';
import { InspectionResponseForm } from './response-form';

export const metadata = { title: 'Inspections' };
export const dynamic = 'force-dynamic';

const KIND: Record<string, string> = {
  move_in: 'Move-in inspection',
  move_out: 'Move-out inspection',
  routine: 'Routine inspection',
  other: 'Inspection',
};

const CONDITION: Record<string, StatusTone> = {
  good: 'positive',
  fair: 'caution',
  poor: 'critical',
  damaged: 'critical',
};

/**
 * The inspections of this home, and the resident's answer to each.
 *
 * `respondToInspection` existed with tests and no screen, so a report
 * recording damage against somebody's deposit could be finalised and the
 * person it was about had no way to agree or disagree. Of everything this
 * product produces, that report is the most likely to cost a tenant money.
 *
 * Only finalised reports appear: `app.resident_inspection_ids()` draws the
 * line, so an inspector's draft is not reachable here and this page adds no
 * second opinion about who may see what.
 */
export default async function InspectionsPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  const viewer = await requireViewer();
  if (!viewer.residentLeases.some((l) => l.leaseId === leaseId)) notFound();

  const inspections = await readAs(viewer, async (tx) => {
    const [party] = await tx<{ resident_id: string }[]>`
      select lp.resident_id from lease_parties lp
      join portal_links pl on pl.resident_id = lp.resident_id and pl.lease_id = lp.lease_id
      where lp.lease_id = ${leaseId}::uuid and pl.auth_user_id = ${viewer.authUserId}::uuid
      limit 1
    `;
    if (!party) return [];
    return residentInspections(tx, leaseId, party.resident_id);
  });

  return (
    <section aria-labelledby="inspections-heading" className="space-y-3">
      <SectionHeading id="inspections-heading">Inspections</SectionHeading>

      {inspections.length === 0 ? (
        <Card className="px-4 py-8 text-center text-sm text-ink-500">
          No inspection report has been finalised for your home. When one is, it appears here
          with everything that was recorded, and you can say whether you agree with it.
        </Card>
      ) : (
        <div className="space-y-4">
          {inspections.map((inspection) => (
            <Card key={inspection.id} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-ink-900">
                    {KIND[inspection.inspectionType] ?? 'Inspection'}
                  </p>
                  <p className="text-xs text-ink-500">
                    {inspection.performedOn
                      ? `Carried out ${formatDate(inspection.performedOn)}`
                      : 'Date not recorded'}
                    {inspection.inspectorName ? ` · ${inspection.inspectorName}` : ''}
                    {inspection.keysHandedOver
                      ? ` · keys handed over ${formatDate(inspection.keysHandedOver)}`
                      : ''}
                  </p>
                </div>
                {inspection.myResponse ? (
                  <StatusBadge
                    tone={inspection.myResponse.response === 'disputed' ? 'caution' : 'positive'}
                  >
                    {inspection.myResponse.response === 'disputed'
                      ? 'You disagreed'
                      : 'You agreed'}
                  </StatusBadge>
                ) : (
                  <StatusBadge tone="info">Waiting on you</StatusBadge>
                )}
              </div>

              {inspection.items.length === 0 ? (
                <p className="mt-3 text-sm text-ink-500">
                  No items were recorded on this report.
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-ink-100">
                  {inspection.items.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-baseline gap-2 py-2 text-sm">
                      <span className="min-w-32 font-medium text-ink-900">{item.room}</span>
                      <span className="flex-1 text-ink-700">{item.item}</span>
                      <StatusBadge tone={CONDITION[item.condition] ?? 'neutral'}>
                        {item.condition.replace(/_/g, ' ')}
                      </StatusBadge>
                      {item.damageType ? (
                        <span className="text-xs text-critical-700">
                          {item.damageType.replace(/_/g, ' ')}
                        </span>
                      ) : null}
                      {item.note ? (
                        <span className="w-full text-xs text-ink-500">{item.note}</span>
                      ) : null}
                      {item.photos.length > 0 ? (
                        <ul className="w-full space-y-1 pt-1 text-xs">
                          {item.photos.map((photo) => (
                            <li key={photo.documentId}>
                              {photo.openable ? (
                                <a
                                  href={`/portal/${leaseId}/documents/${photo.documentId}`}
                                  className="text-spike-600 hover:underline"
                                >
                                  {photo.title} — download the photograph ↓
                                </a>
                              ) : (
                                <span className="text-ink-500">
                                  {photo.title} — the photograph is held unopened on this
                                  installation and nobody can open it, your landlord included
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {inspection.myResponse ? (
                <p className="mt-3 rounded-lg bg-ink-50 p-3 text-sm text-ink-700">
                  You answered {formatDate(inspection.myResponse.respondedAt)}
                  {inspection.myResponse.comment
                    ? `: “${inspection.myResponse.comment}”`
                    : '.'}
                </p>
              ) : null}

              <InspectionResponseForm
                leaseId={leaseId}
                inspectionId={inspection.id}
                existing={inspection.myResponse
                  ? {
                    response: inspection.myResponse.response,
                    comment: inspection.myResponse.comment,
                  }
                  : null}
              />
            </Card>
          ))}
        </div>
      )}

      <p className="text-xs text-ink-400">
        Photographs on a report are the evidence behind any deduction from your deposit, so
        you can see the same ones your landlord can. Your landlord sees your answer on the
        report itself. Disagreeing does not change what
        the report says — it records your side of it next to theirs, which is what a deduction
        from your deposit has to be justified against.
      </p>
    </section>
  );
}
