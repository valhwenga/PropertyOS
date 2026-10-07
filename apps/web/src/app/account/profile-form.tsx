'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { FieldErrors } from '@/components/field-errors';
import { saveProfileAction } from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function ProfileForm({
  fullName, email, phone,
}: { fullName: string; email: string; phone: string }) {
  const [state, action, pending] = useActionState(saveProfileAction, null);

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        {state && !state.ok ? (
          <div>
            <ErrorState title="Could not save your profile" detail={state.message}
                        correlationId={state.correlationId} />
            <FieldErrors errors={state.fieldErrors} />
          </div>
        ) : null}
        {state?.ok ? <p className="text-sm text-positive-600">Saved.</p> : null}

        <div>
          <label className={LABEL} htmlFor="fullName">Your name</label>
          <input id="fullName" name="fullName" required defaultValue={fullName}
                 className={`mt-1 ${FIELD}`} />
        </div>

        <div>
          <label className={LABEL} htmlFor="email">Email address</label>
          <input id="email" value={email} readOnly disabled
                 className={`mt-1 ${FIELD} opacity-70`} />
          <p className="mt-1 text-xs text-ink-500">
            This is how you sign in, so it is not editable here. Changing it would change who the
            account is, which needs the new address verified first.
          </p>
        </div>

        <div>
          <label className={LABEL} htmlFor="phone">Phone</label>
          <input id="phone" name="phone" defaultValue={phone} className={`mt-1 ${FIELD}`} />
        </div>

        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </Card>
  );
}
