'use server';

import { createHash, randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { privilegedSql } from '@propertyos/db/client';
import { acceptInvitation, DomainError } from '@propertyos/domain';
import { createSession, hashPassword, verifyPassword } from '@/lib/session';

export interface PortalJoinState {
  error: string | null;
  correlationId?: string;
}

/**
 * A resident accepting their portal invitation.
 *
 * `acceptInvitation` has existed since §8 and nothing called it: an invitation
 * could not be issued, and could not have been redeemed if it had been.
 *
 * Runs on the privileged connection because the resident has no session and no
 * membership for row-level security to scope them by. Narrow in return: it
 * reads one portal link by the hash of the token, creates at most one account,
 * and binds it to that one link, consuming the token on the way.
 *
 * The same rule as the staff invitation: a link is authority to be given
 * access, not authority to be somebody. An address that already has an account
 * must prove itself with its password.
 */
export async function acceptPortalInvitationAction(
  _previous: PortalJoinState, formData: FormData,
): Promise<PortalJoinState> {
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
  // Hashed here rather than with the database's own digest(), so there is one
  // implementation of "which link is this" shared with `acceptInvitation`.
  const tokenHash = createHash('sha256').update(token).digest();
  let signedIn = false;

  try {
    signedIn = await sql.begin(async (tx) => {
      const [link] = await tx<
        { invited_email: string; status: string; expires_at: string }[]
      >`
        select invited_email::text as invited_email, status::text, expires_at::text
          from portal_links
         where invite_token_hash = ${tokenHash}
      `;
      // A wrong, expired, revoked or spent token all produce the same answer,
      // so the link cannot be used to find out whether an address was invited.
      const generic = new DomainError(
        'not_found',
        'This invitation link is not valid. It may have expired or already been used. Ask '
          + 'your landlord or agent for a new one.',
      );
      if (!link || link.status !== 'invited') throw generic;
      if (new Date(link.expires_at) < new Date()) throw generic;

      const [existing] = await tx<{ id: string; password_hash: string | null }[]>`
        select id, password_hash from auth.users where email = ${link.invited_email}
      `;
      const authUserId = existing?.id ?? randomUUID();

      if (existing) {
        // The link grants access to a lease; it is not proof of identity. A
        // resident who already has an account — a second lease, or a previous
        // tenancy — confirms with the password they already use.
        const correct = existing.password_hash
          ? await verifyPassword(password, existing.password_hash)
          : false;
        if (!correct) {
          throw new DomainError(
            'forbidden',
            'That is not the password for this address. You already have an account here, so '
              + 'your existing password confirms it is you.',
          );
        }
      } else {
        const hash = await hashPassword(password);
        await tx`
          insert into auth.users (id, email, password_hash)
          values (${authUserId}, ${link.invited_email}, ${hash})
        `;
        await tx`
          insert into user_profiles (auth_user_id, full_name, email, is_platform_operator)
          values (
            ${authUserId},
            -- The name on the resident record, not one typed on this page: the
            -- operator confirmed who this invitation was for.
            (select trim(coalesce(rp.first_name, '') || ' ' || coalesce(rp.last_name, ''))
               from portal_links pl
               join resident_profiles rp on rp.id = pl.resident_id
              where pl.invite_token_hash = ${tokenHash}),
            ${link.invited_email}, false
          )
          on conflict (auth_user_id) do nothing
        `;
      }

      await acceptInvitation(tx as never, { token, authUserId });

      if (existing) {
        // No session for an account that already exists: it may carry a second
        // factor, and minting one here would get past it.
        return false;
      }
      await createSession(authUserId, 'aal1');
      return true;
    });
  } catch (error) {
    if (error instanceof DomainError) {
      return { error: error.message, correlationId };
    }
    process.stderr.write(
      `[${correlationId}] accepting a portal invitation failed: `
        + `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    return {
      error: 'Something went wrong accepting this invitation. Please try the link again.',
      correlationId,
    };
  }

  redirect(signedIn ? '/portal' : '/sign-in?joined=1');
}
