'use server';

import { headers } from 'next/headers';
import { withAnonymous } from '@propertyos/db';
import { DomainError, requestAccess } from '@propertyos/domain';
import { clientAddressHash } from '@/lib/rate-limit';

/**
 * A public submission, so it cannot go through `command`, which requires a
 * session. It runs with no actor and names no organisation, because at this
 * point there is no organisation — that is the thing being asked for.
 *
 * The address hash is the same coarse grouping key the sign-in limiter uses.
 * It is passed to the database, which decides; doing the counting here would
 * put the brake on the side of the request that an attacker controls.
 */
export async function requestAccessAction(_previous: unknown, formData: FormData) {
  const text = (key: string) => String(formData.get(key) ?? '').trim();
  const sizeText = text('portfolioSize');

  try {
    const header = await headers();
    const origin = header.get('origin');
    const host = header.get('host');
    if (origin && host && ![`https://${host}`, `http://${host}`].includes(origin)) {
      return { ok: false as const, message: 'This request did not originate from PropertyOS.' };
    }

    const ipHash = await clientAddressHash();
    await withAnonymous((tx) =>
      requestAccess(
        tx,
        {
          organisationName: text('organisationName'),
          contactName: text('contactName'),
          contactEmail: text('contactEmail'),
          ...(text('contactPhone') ? { contactPhone: text('contactPhone') } : {}),
          ...(sizeText ? { portfolioSize: Number(sizeText) } : {}),
          ...(text('note') ? { note: text('note') } : {}),
        },
        { ipHash },
      ),
    );
    return { ok: true as const };
  } catch (error) {
    // Only two kinds of message are shown. The domain's own, and the ones the
    // security-definer function raises deliberately with the two codes below
    // — "enter a valid email address", "too many requests from here today" —
    // which are written to be read by whoever typed the form. Anything else
    // is a database error whose text can carry schema, so it is logged and
    // reported generically.
    const RAISED_FOR_THE_READER = new Set(['22023', '53300']);
    const code = (error as { code?: string } | null)?.code;
    if (error instanceof DomainError || (typeof code === 'string' && RAISED_FOR_THE_READER.has(code))) {
      return { ok: false as const, message: (error as Error).message };
    }
    console.error(JSON.stringify({
      level: 'error',
      message: error instanceof Error ? error.message : 'unknown error',
      at: 'requestAccessAction',
    }));
    return {
      ok: false as const,
      message: 'That could not be sent. Please try again in a moment.',
    };
  }
}
