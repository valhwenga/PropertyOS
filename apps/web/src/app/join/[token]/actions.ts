'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { privilegedSql } from '@propertyos/db/client';
import { acceptStaffInvitation, describeStaffInvitation, DomainError } from '@propertyos/domain';
import { createSession, hashPassword, verifyPassword } from '@/lib/session';

export interface JoinState {
  error: string | null;
  correlationId?: string;
  /**
   * Set when the invitation was accepted for an account that already existed.
   * No session is created in that case: they sign in normally, which is what
   * puts them through their own second factor.
   */
  signInRequired?: boolean;
}

/**
 * Accepting a staff invitation.
 *
 * Runs on a privileged connection because the person has no session and no
 * membership yet — there is nothing for row-level security to scope them by.
 * It is narrowly scoped in return: it reads one invitation by token hash,
 * creates at most one account, and binds it to that one invitation.
 *
 * The invitation is the authorisation. It carries the roles and the scope, it
 * was issued by somebody holding the membership permission, it expires, and it
 * is consumed on use — so this path cannot be used to join an organisation
 * nobody invited you to.
 */
export async function acceptInvitationAction(
  _previous: JoinState, formData: FormData,
): Promise<JoinState> {
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
  let slug: string | null = null;

  try {
    slug = await sql.begin(async (tx) => {
      const invitation = await describeStaffInvitation(tx as never, token);
      if (!invitation) {
        throw new DomainError(
          'not_found',
          'This invitation is not valid. It may have expired, been withdrawn, or already been '
            + 'used. Ask whoever invited you for a new one.',
        );
      }

      // One account per address. Somebody invited to a second organisation
      // under an address they already use keeps the account they have, and
      // their existing password is never reset by this.
      const [existing] = await tx<{ id: string; password_hash: string | null }[]>`
        select id, password_hash from auth.users where email = ${invitation.invitedEmail}
      `;
      const authUserId = existing?.id ?? randomUUID();

      if (existing) {
        // The password MUST be checked here. An invitation link is not
        // authority to act as somebody who already has an account: without
        // this, anybody holding the link could join as them and walk away with
        // a session. The invitation authorises the membership, not the
        // identity.
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

      const { organisationId } = await acceptStaffInvitation(tx as never, {
        token, authUserId,
      });

      const [organisation] = await tx<{ slug: string }[]>`
        select slug from organisations where id = ${organisationId}
      `;

      if (existing) {
        // Deliberately no session. An account that already exists may have a
        // second factor on it, and minting a session here would get them past
        // it. They sign in the normal way instead.
        return null;
      }

      // A brand new account, which has no second factor yet, so a
      // single-factor session is all there is to give. Any role that needs one
      // keeps its permissions withheld until they enrol it — accepting an
      // invitation is not the same as proving who you are.
      await createSession(authUserId, 'aal1');
      return organisation?.slug ?? null;
    });
  } catch (error) {
    if (error instanceof DomainError) {
      return { error: error.message, correlationId };
    }
    // The person gets nothing specific — an invitation endpoint that explained
    // its internals would be a probe. The log gets the detail, with the same
    // correlation id, because a generic message that leaves no trace anywhere
    // is a failure nobody can diagnose.
    process.stderr.write(
      `[${correlationId}] accepting a staff invitation failed: `
        + `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    return {
      error: 'Something went wrong accepting this invitation. Please try the link again.',
      correlationId,
    };
  }

  // No slug means an existing account accepted it: they have no session, so
  // they go to sign in rather than to a console that would bounce them.
  redirect(slug ? `/app/${slug}` : '/sign-in?joined=1');
}
