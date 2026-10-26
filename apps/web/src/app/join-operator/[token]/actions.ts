'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { privilegedSql } from '@propertyos/db/client';
import {
  acceptOperatorInvitation, describeOperatorInvitation, DomainError,
} from '@propertyos/domain';
import { createSession, hashPassword, verifyPassword } from '@/lib/session';

export interface JoinOperatorState {
  error: string | null;
  correlationId?: string;
}

/**
 * Accepting an invitation to become a Spike operator.
 *
 * The same shape as accepting a staff invitation, and privileged for the same
 * reason: the person has no session and belongs to nothing, so there is no
 * row-level context to run under. It is narrow in return — one invitation
 * found by the hash of the token, at most one account created, and the only
 * path in the product that may set `is_platform_operator`.
 *
 * An invitation is authority over a ROLE, never over an identity. If the
 * address already has an account, the password for it is required: otherwise
 * anybody holding the link could become that person and walk away with the
 * most privileged session in the product.
 */
export async function acceptOperatorInvitationAction(
  _previous: JoinOperatorState, formData: FormData,
): Promise<JoinOperatorState> {
  const correlationId = randomUUID();
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirmPassword') ?? '');

  if (password.length < 12) {
    return { error: 'Choose a password of at least 12 characters.', correlationId };
  }
  if (password !== confirm) {
    return { error: 'Those two passwords do not match.', correlationId };
  }

  const sql = privilegedSql();
  let createdAccount = false;

  try {
    createdAccount = await sql.begin(async (tx) => {
      const invitation = await describeOperatorInvitation(tx as never, token);
      if (!invitation) {
        throw new DomainError(
          'not_found',
          'This invitation is not valid. It may have expired, been withdrawn, or already '
            + 'been used. Ask whoever invited you for a new one.',
        );
      }

      const [existing] = await tx<{ id: string; password_hash: string | null }[]>`
        select id, password_hash from auth.users where email = ${invitation.invitedEmail}
      `;
      const authUserId = existing?.id ?? randomUUID();

      if (existing) {
        const correct = existing.password_hash
          ? await verifyPassword(password, existing.password_hash)
          : false;
        if (!correct) {
          throw new DomainError(
            'forbidden',
            'That is not the password for this account. This invitation is for an address '
              + 'that already has one, so your existing password confirms it is you.',
          );
        }
      } else {
        const hash = await hashPassword(password);
        await tx`
          insert into auth.users (id, email, password_hash)
          values (${authUserId}, ${invitation.invitedEmail}, ${hash})
        `;
        await tx`
          insert into user_profiles (auth_user_id, full_name, email, is_platform_operator)
          values (${authUserId}, ${invitation.fullName}, ${invitation.invitedEmail}, false)
          on conflict (auth_user_id) do nothing
        `;
      }

      await acceptOperatorInvitation(tx as never, { token, authUserId });

      if (existing) {
        // No session, deliberately: an existing account may carry a second
        // factor and minting one here would get them past it.
        return false;
      }

      // A new account has no second factor yet, and the console refuses
      // single-factor sessions outright — so this session exists only to get
      // them to the enrolment screen.
      await createSession(authUserId, 'aal1');
      return true;
    });
  } catch (error) {
    if (error instanceof DomainError) {
      return { error: error.message, correlationId };
    }
    process.stderr.write(
      `[${correlationId}] accepting an operator invitation failed: `
        + `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    return {
      error: 'Something went wrong accepting this invitation. Please try the link again.',
      correlationId,
    };
  }

  // Straight to enrolment rather than to the console, which would bounce a
  // single-factor session and read as a broken invitation.
  redirect(createdAccount ? '/account/security' : '/sign-in?joined=1');
}
