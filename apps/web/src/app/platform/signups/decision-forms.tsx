'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import { approveSignupRequestAction, declineSignupRequestAction } from './actions';

/**
 * One request, with both decisions on it.
 *
 * The approval form is the provisioning form with the request's details
 * already in it: the operator still chooses the address, the plan and the
 * legal entity, because those three are the ones a stranger typing into a
 * public form has no business deciding.
 */

interface RequestView {
  id: string;
  organisationName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  portfolioSize: number | null;
  note: string | null;
  status: 'requested' | 'provisioned' | 'declined';
  declineReason: string | null;
  createdAt: string;
  suggestedSlug: string;
}

interface PlanChoice { key: string; name: string; includedUnits: number }

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function RequestDecision({
  request, plans, baseUrl,
}: { request: RequestView; plans: PlanChoice[]; baseUrl: string }) {
  const [approval, approve, approving] = useActionState(approveSignupRequestAction, null);
  const [decline, declineAction, declining] = useActionState(declineSignupRequestAction, null);
  const [showDecline, setShowDecline] = useState(false);

  const provisioned = approval?.ok
    ? (approval as unknown as { token: string; slug: string; expiresAt: string })
    : null;

  if (provisioned) {
    return (
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-ink-900">
          {provisioned.slug} is set up, with nobody in it
        </h3>
        <p className="mt-1 text-sm text-ink-700">
          <strong>No email has been sent.</strong> Give this link to {request.contactEmail}{' '}
          yourself. It is shown once: only a hash is stored, so nobody can recover it
          afterwards.
        </p>
        <p className="mt-3 break-all rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-xs">
          {baseUrl}/join/{provisioned.token}
        </p>
        <p className="mt-2 text-xs text-ink-500">
          Valid until {provisioned.expiresAt.slice(0, 10)}.
        </p>
      </Card>
    );
  }

  // Already decided, by somebody or by this screen a moment ago. The compact
  // row, unless this component is the one still holding a link that is shown
  // once — handled above.
  if (request.status !== 'requested' || decline?.ok) {
    const provisionedElsewhere = request.status === 'provisioned';
    return (
      <Card className="flex flex-wrap items-baseline justify-between gap-3 p-4">
        <div>
          <p className="text-sm font-medium text-ink-900">{request.organisationName}</p>
          <p className="text-xs text-ink-500">
            {request.contactName} ({request.contactEmail}) · asked {request.createdAt}
            {request.declineReason ? ` · ${request.declineReason}` : ''}
          </p>
          {decline?.ok && !provisionedElsewhere ? (
            <p className="mt-1 text-xs text-ink-500">
              Nobody has been told: there is no email provider, so the reason is recorded here
              and contacting them is yours to do.
            </p>
          ) : null}
        </div>
        <StatusBadge
          tone={provisionedElsewhere ? 'positive' : 'neutral'}
          glyph={provisionedElsewhere ? '\u25cf' : '\u25a0'}
        >
          {provisionedElsewhere ? 'set up' : 'declined'}
        </StatusBadge>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">{request.organisationName}</h3>
        <p className="text-xs text-ink-500">asked {request.createdAt}</p>
      </div>
      <p className="mt-1 text-sm text-ink-700">
        {request.contactName} · {request.contactEmail}
        {request.contactPhone ? ` · ${request.contactPhone}` : ''}
        {request.portfolioSize !== null ? ` · says they manage ${request.portfolioSize} units` : ''}
      </p>
      {request.note ? (
        <p className="mt-2 rounded-lg bg-ink-50 p-3 text-sm text-ink-700">{request.note}</p>
      ) : null}
      <p className="mt-2 text-xs text-ink-500">
        None of this is verified. The address has not been confirmed and nothing has been
        charged.
      </p>

      {approval && !approval.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{approval.message}</p>
        </div>
      ) : null}

      <form action={approve} className="mt-4 space-y-4 border-t border-ink-100 pt-4">
        <input type="hidden" name="requestId" value={request.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor={`name-${request.id}`}>Trading name</label>
            <input
              id={`name-${request.id}`} name="name" defaultValue={request.organisationName}
              maxLength={200} className={`mt-1 ${FIELD}`}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor={`legal-${request.id}`}>Registered legal name</label>
            <input
              id={`legal-${request.id}`} name="legalEntityName" required maxLength={200}
              defaultValue={request.organisationName} className={`mt-1 ${FIELD}`}
            />
            <p className="mt-1 text-xs text-ink-500">What appears on their invoices.</p>
          </div>
          <div>
            <label className={LABEL} htmlFor={`slug-${request.id}`}>Address</label>
            <input
              id={`slug-${request.id}`} name="slug" required
              defaultValue={request.suggestedSlug}
              pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
              className={`mt-1 ${FIELD} font-mono`}
            />
            <p className="mt-1 text-xs text-ink-500">
              It appears in every URL they use and cannot be changed casually.
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor={`plan-${request.id}`}>Plan</label>
            <select id={`plan-${request.id}`} name="planKey" required className={`mt-1 ${FIELD}`}>
              {plans.map((plan) => (
                <option key={plan.key} value={plan.key}>
                  {plan.name} — {plan.includedUnits} units included
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={approving}>
            {approving ? 'Setting it up…' : 'Approve and set up'}
          </Button>
          <button
            type="button"
            onClick={() => setShowDecline((open) => !open)}
            className="text-sm font-medium text-ink-600 hover:underline"
          >
            {showDecline ? 'Keep it open' : 'Decline instead'}
          </button>
        </div>
      </form>

      {showDecline ? (
        <form action={declineAction} className="mt-4 space-y-3 border-t border-ink-100 pt-4">
          <input type="hidden" name="requestId" value={request.id} />
          {decline && !decline.ok ? (
            <div className="rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
              <p className="text-sm text-critical-700">{decline.message}</p>
            </div>
          ) : null}
          <div>
            <label className={LABEL} htmlFor={`reason-${request.id}`}>Why</label>
            <input
              id={`reason-${request.id}`} name="reason" required minLength={5} maxLength={500}
              placeholder="Duplicate of an existing customer" className={`mt-1 ${FIELD}`}
            />
            <p className="mt-1 text-xs text-ink-500">
              Kept on the request so the queue is readable in six months. Nothing is sent.
            </p>
          </div>
          <Button type="submit" variant="secondary" disabled={declining}>
            {declining ? 'Declining…' : 'Decline this request'}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}
