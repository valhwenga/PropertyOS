'use server';

import { randomUUID } from 'node:crypto';
import { privilegedSql } from '@propertyos/db/client';
import {
  beginEnrolment, confirmEnrolment, groupSecret, regenerateRecoveryCodes, removeFactor,
} from '@/lib/mfa';
import { requireViewer } from '@/lib/auth';
import { verifyPassword } from '@/lib/session';

/**
 * Your own second factor.
 *
 * Every one of these acts on the signed-in person's own account and on nothing
 * else: the user id comes from the session, never from the form. There is no
 * administrator reset anywhere in the product, because an administrator who
 * could clear a colleague's second factor could take over their account, which
 * is the thing the factor exists to prevent.
 *
 * These run on the privileged connection because `auth_mfa_factors` holds TOTP
 * secrets and its privileges are revoked from the application role — the same
 * reason sign-in does.
 */

export interface SecurityState {
  error: string | null;
  correlationId?: string;
  /** Shown once, while the person is setting up their app. */
  secret?: string;
  groupedSecret?: string;
  uri?: string;
  /** Shown once, at enrolment or re-issue. */
  recoveryCodes?: string[];
  message?: string;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? '');

/** Confirms it is really them, for a change to how they prove who they are. */
async function passwordMatches(authUserId: string, password: string): Promise<boolean> {
  const [user] = await privilegedSql()<{ password_hash: string | null }[]>`
    select password_hash from auth.users where id = ${authUserId}
  `;
  if (!user?.password_hash) return false;
  return verifyPassword(password, user.password_hash);
}

export async function beginEnrolmentAction(
  _previous: SecurityState, _formData: FormData,
): Promise<SecurityState> {
  const correlationId = randomUUID();
  const viewer = await requireViewer();

  const started = await beginEnrolment(privilegedSql(), viewer.authUserId, viewer.email);
  if (!started.ok) {
    return {
      error: 'You already have an authenticator set up. Remove it first if you are replacing it.',
      correlationId,
    };
  }
  return {
    error: null,
    secret: started.secret,
    groupedSecret: groupSecret(started.secret),
    uri: started.uri,
  };
}

export async function confirmEnrolmentAction(
  _previous: SecurityState, formData: FormData,
): Promise<SecurityState> {
  const correlationId = randomUUID();
  const viewer = await requireViewer();

  const result = await confirmEnrolment(
    privilegedSql(), viewer.authUserId, str(formData, 'code'),
  );
  if (!result.ok) {
    const error = result.reason === 'nothing_pending'
      ? 'There is nothing waiting to be confirmed. Start again.'
      : result.reason === 'replayed'
        ? 'That code has already been used. Wait for your app to show a new one.'
        : 'That code does not match. Check the time on your phone and try the next one.';
    // The secret is carried back so a mistyped code does not force them to
    // start over and re-add the entry in their app.
    return {
      error,
      correlationId,
      secret: str(formData, 'secret') || undefined,
      groupedSecret: str(formData, 'secret') ? groupSecret(str(formData, 'secret')) : undefined,
      uri: str(formData, 'uri') || undefined,
    };
  }

  return {
    error: null,
    recoveryCodes: result.recoveryCodes,
    message: 'Your authenticator is set up. Sign out and in again for your elevated '
      + 'permissions to take effect on this session.',
  };
}

export async function regenerateCodesAction(
  _previous: SecurityState, formData: FormData,
): Promise<SecurityState> {
  const correlationId = randomUUID();
  const viewer = await requireViewer();

  if (!(await passwordMatches(viewer.authUserId, str(formData, 'password')))) {
    return { error: 'That is not your password.', correlationId };
  }

  const result = await regenerateRecoveryCodes(privilegedSql(), viewer.authUserId);
  if (!result.ok) {
    return { error: 'You have no authenticator set up, so there is nothing to recover to.', correlationId };
  }
  return {
    error: null,
    recoveryCodes: result.recoveryCodes,
    message: 'New recovery codes. Every code from your previous list has stopped working.',
  };
}

export async function removeFactorAction(
  _previous: SecurityState, formData: FormData,
): Promise<SecurityState> {
  const correlationId = randomUUID();
  const viewer = await requireViewer();

  if (!(await passwordMatches(viewer.authUserId, str(formData, 'password')))) {
    return { error: 'That is not your password.', correlationId };
  }

  await removeFactor(privilegedSql(), viewer.authUserId);
  return {
    error: null,
    message: 'Your authenticator and all of your recovery codes have been removed. Any role '
      + 'that needs a second factor has its permissions withheld until you set one up again.',
  };
}
