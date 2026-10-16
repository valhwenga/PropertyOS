'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import {
  beginEnrolmentAction, confirmEnrolmentAction, regenerateCodesAction, removeFactorAction,
  type SecurityState,
} from './actions';

const initial: SecurityState = { error: null };

function Problem({ state, title }: { state: SecurityState; title: string }) {
  if (!state.error) return null;
  return <ErrorState title={title} detail={state.error} correlationId={state.correlationId} />;
}

/** Shown once. Never retrievable afterwards, which is the point. */
function RecoveryCodes({ codes, message }: { codes: string[]; message?: string }) {
  return (
    <Card className="border-caution-700/30 bg-caution-50 p-4">
      <h2 className="text-sm font-semibold text-caution-700">
        Your recovery codes — save them now
      </h2>
      <p className="mt-1 text-sm text-ink-700">
        {message} Each code works once. They are the only way back in if you lose your phone:
        nobody at your organisation and nobody at Spike can reset your authenticator for you,
        because anybody who could would be able to take over your account.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm">
        {codes.map((code) => <li key={code}>{code}</li>)}
      </ul>
      <p className="mt-3 text-xs text-ink-500">
        This list is shown once. It is stored only as hashes, so it cannot be shown again —
        print it, or put it somewhere that is not the phone with the authenticator on it.
      </p>
    </Card>
  );
}

export function EnrolForm({ email }: { email: string }) {
  const [begun, begin, beginning] = useActionState(beginEnrolmentAction, initial);
  const [confirmed, confirm, confirming] = useActionState(confirmEnrolmentAction, initial);

  if (confirmed.recoveryCodes) {
    return <RecoveryCodes codes={confirmed.recoveryCodes} message={confirmed.message} />;
  }

  const secret = confirmed.secret ?? begun.secret;
  const grouped = confirmed.groupedSecret ?? begun.groupedSecret;
  const uri = confirmed.uri ?? begun.uri;

  if (!secret) {
    return (
      <Card className="p-5">
        <form action={begin} className="space-y-3">
          <h2 className="text-sm font-semibold text-ink-900">Set up an authenticator app</h2>
          <p className="text-sm text-ink-700">
            Some roles — approving a refund, administering the organisation — need a second
            factor before their permissions take effect. Until you set one up you can sign in
            and will see very little.
          </p>
          <Problem state={begun} title="Could not start" />
          <Button type="submit" variant="primary" disabled={beginning}>
            {beginning ? 'Preparing…' : 'Start setting one up'}
          </Button>
        </form>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <form action={confirm} className="space-y-4">
        <input type="hidden" name="secret" value={secret} />
        <input type="hidden" name="uri" value={uri ?? ''} />

        <h2 className="text-sm font-semibold text-ink-900">Add this to your authenticator app</h2>
        <Problem state={confirmed} title="Not confirmed" />

        <p className="text-sm text-ink-700">
          In Google Authenticator, 1Password, Authy or any similar app, add an account by
          entering a key by hand, for <strong>{email}</strong>:
        </p>
        <p className="break-all rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-sm tracking-wider">
          {grouped}
        </p>
        <p className="text-xs text-ink-500">
          There is no QR code to scan. Drawing one would mean either another dependency or a
          few hundred lines of arithmetic, and every authenticator app accepts a typed key —
          so this is the version that works rather than a promise of a picture. If your app
          takes a link, it is{' '}
          <span className="break-all font-mono">{uri}</span>.
        </p>

        <div className="space-y-1.5">
          <label htmlFor="code" className="block text-sm font-medium text-ink-700">
            The 6-digit code your app now shows
          </label>
          <input
            id="code" name="code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required
            autoComplete="one-time-code"
            className="tabular w-full rounded-lg border border-ink-200 px-3 py-2 text-lg tracking-widest"
          />
          <p className="text-xs text-ink-500">
            Nothing is switched on until this matches — which is how you find out now rather
            than the next time you try to sign in.
          </p>
        </div>

        <Button type="submit" variant="primary" disabled={confirming}>
          {confirming ? 'Checking…' : 'Confirm and switch it on'}
        </Button>
      </form>
    </Card>
  );
}

export function ManageFactorForm({
  unusedRecoveryCodes, enrolledAt,
}: {
  unusedRecoveryCodes: number; enrolledAt: string | null;
}) {
  const [reissued, reissue, reissuing] = useActionState(regenerateCodesAction, initial);
  const [removed, remove, removing] = useActionState(removeFactorAction, initial);

  if (removed.message) {
    return (
      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">Authenticator removed</h2>
        <p className="mt-1 text-sm text-ink-700">{removed.message}</p>
        <p className="mt-2 text-sm text-ink-500">Reload this page to set a new one up.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {reissued.recoveryCodes ? (
        <RecoveryCodes codes={reissued.recoveryCodes} message={reissued.message} />
      ) : null}

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink-900">Your authenticator</h2>
        <p className="mt-1 text-sm text-ink-700">
          Set up{enrolledAt ? ` on ${enrolledAt.slice(0, 10)}` : ''}. Signing in with a code
          from it gives this session its elevated permissions.
        </p>
        <p className="mt-2 text-sm text-ink-700">
          {unusedRecoveryCodes === 0 ? (
            <strong>
              You have no recovery codes left. If you lose your phone now there is no way back
              into this account — issue a new set.
            </strong>
          ) : unusedRecoveryCodes <= 2 ? (
            <strong>
              {unusedRecoveryCodes} recovery{' '}
              {unusedRecoveryCodes === 1 ? 'code' : 'codes'} left. Issue a new set before you
              run out.
            </strong>
          ) : (
            `${unusedRecoveryCodes} recovery codes left.`
          )}
        </p>
      </Card>

      <Card className="p-5">
        <form action={reissue} className="space-y-3">
          <h3 className="text-sm font-semibold text-ink-900">New recovery codes</h3>
          <p className="text-sm text-ink-700">
            Every code on your current list stops working. Do this if you think the list has
            been seen by somebody else, or if you have run low.
          </p>
          <Problem state={reissued} title="Not issued" />
          <div className="space-y-1.5">
            <label htmlFor="reissue-password" className="block text-sm font-medium text-ink-700">
              Your password
            </label>
            <input
              id="reissue-password" name="password" type="password" required
              autoComplete="current-password"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={reissuing}>
            {reissuing ? 'Issuing…' : 'Issue new recovery codes'}
          </Button>
        </form>
      </Card>

      <Card className="p-5">
        <form action={remove} className="space-y-3">
          <h3 className="text-sm font-semibold text-ink-900">Remove the authenticator</h3>
          <p className="text-sm text-ink-700">
            For a new phone: remove this one, then set up the new one. Your recovery codes go
            with it, and any role that needs a second factor has its permissions withheld
            until you set one up again.
          </p>
          <Problem state={removed} title="Not removed" />
          <div className="space-y-1.5">
            <label htmlFor="remove-password" className="block text-sm font-medium text-ink-700">
              Your password
            </label>
            <input
              id="remove-password" name="password" type="password" required
              autoComplete="current-password"
              className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={removing}>
            {removing ? 'Removing…' : 'Remove it'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
