'use client';

import { useActionState, useEffect, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import { saveApprovalPolicyAction } from './actions';

/**
 * One action's rule.
 *
 * A form per action rather than one form for all three: they are separate
 * decisions, a landlord will change one of them and not the others, and a
 * single Save that silently rewrites the two you did not look at is how a
 * control gets loosened by accident.
 */
export function PolicyForm({
  org, actionKey, label, description, approvalsRequired, thresholdMajor, currencyCode,
  updatedAt, updatedByName,
}: {
  org: string;
  actionKey: string;
  label: string;
  description: string;
  approvalsRequired: 1 | 2;
  thresholdMajor: string;
  currencyCode: string;
  updatedAt: string | null;
  updatedByName: string | null;
}) {
  const [state, action, pending] = useActionState(saveApprovalPolicyAction, null);
  const [required, setRequired] = useState(approvalsRequired);

  // React resets a form after a Server Action runs, restoring each field to
  // the DEFAULT of the current render. So the radios are uncontrolled, with
  // their default taken from what the server last said: the reset then shows
  // what was saved. Controlled inputs looked right until the save, after which
  // a stored rule of two sat under a radio reading "One".
  //
  // The state below is for the wording and for the threshold field, which
  // follow the choice immediately rather than waiting for a round trip.
  useEffect(() => { setRequired(approvalsRequired); }, [approvalsRequired]);

  return (
    <form action={action} className="space-y-3 p-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="actionKey" value={actionKey} />

      <div>
        <p className="text-[length:var(--text-table)] font-medium text-ink-900">{label}</p>
        <p className="text-[length:var(--text-meta)] text-ink-500">{description}</p>
      </div>

      {state && !state.ok ? (
        <ErrorState
          title="Not saved"
          detail={state.message ?? ''}
          correlationId={state.correlationId}
        />
      ) : null}

      <div className="flex flex-wrap items-end gap-4">
        <fieldset>
          <legend className="text-[length:var(--text-meta)] font-medium text-ink-500">
            Approvers needed
          </legend>
          <div className="mt-1 flex gap-3">
            {([1, 2] as const).map((count) => (
              <label
                key={count}
                className="flex items-center gap-1.5 text-[length:var(--text-table)] text-ink-700"
              >
                <input
                  type="radio"
                  name="approvalsRequired"
                  value={count}
                  defaultChecked={approvalsRequired === count}
                  onChange={() => setRequired(count)}
                />
                {count === 1 ? 'One' : 'Two'}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="text-[length:var(--text-meta)] font-medium text-ink-500">
          <span className="block">From this amount ({currencyCode})</span>
          <input
            name="threshold"
            inputMode="decimal"
            defaultValue={thresholdMajor}
            disabled={required === 1}
            placeholder="0.00"
            className="
              tabular mt-1 w-40 rounded-[var(--radius-control)] border border-ink-200 bg-surface
              px-2.5 py-1.5 text-[length:var(--text-table)] text-ink-900
              disabled:bg-ink-50 disabled:text-ink-400
            "
          />
        </label>

        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <p className="text-[length:var(--text-meta)] text-ink-500">
        {required === 1
          ? 'One approver, which is the product default.'
          : 'Two different people must approve, and neither may be whoever prepared it. '
            + 'Below the amount, one approver is enough — leave it at 0 to require two for '
            + 'every amount.'}
        {updatedAt ? (
          <>
            {' '}Last changed {updatedAt.slice(0, 10)}
            {updatedByName ? ` by ${updatedByName}` : ''}.
          </>
        ) : null}
      </p>

      {state?.ok ? (
        <p className="text-[length:var(--text-meta)] font-medium text-positive-600">
          Saved. It applies to the next decision anybody makes.
        </p>
      ) : null}
    </form>
  );
}
