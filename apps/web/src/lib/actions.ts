import 'server-only';
import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { withActor } from '@propertyos/db';
import type { Sql } from '@propertyos/db';
import { DomainError } from '@propertyos/domain';
import { getViewer, type Viewer } from './auth';

export interface ActionFailure {
  ok: false;
  code: string;
  message: string;
  correlationId: string;
  fieldErrors?: Record<string, string[]>;
}
export type ActionResult<T> = ({ ok: true } & T) | ActionFailure;

/**
 * Cross-site request forgery guard for Server Actions.
 *
 * Next verifies the Origin header for Server Actions itself; this adds an
 * explicit check so the protection is visible and testable rather than implicit.
 */
async function assertSameOrigin(): Promise<void> {
  const header = await headers();
  const origin = header.get('origin');
  if (!origin) return; // Same-origin navigations may omit it.
  const host = header.get('host');
  if (!host) throw new DomainError('forbidden', 'Request origin could not be verified.');
  const expected = new Set([`https://${host}`, `http://${host}`]);
  if (!expected.has(origin)) {
    throw new DomainError('forbidden', 'This request did not originate from PropertyOS.');
  }
}

/**
 * The single entry point for every mutating Server Action.
 *
 * It guarantees, for every command without exception:
 *   1. the caller is authenticated from the signed session cookie;
 *   2. the request originated from this application;
 *   3. the work runs in ONE transaction under the caller's RLS context;
 *   4. failures return a stable code, a readable message and a correlation id —
 *      never a raw database error and never personal data.
 */
export async function command<T>(
  fn: (ctx: { tx: Sql; viewer: Viewer; correlationId: string }) => Promise<T>,
): Promise<ActionResult<T>> {
  const correlationId = randomUUID();
  try {
    await assertSameOrigin();
    const viewer = await getViewer();
    if (!viewer) {
      return { ok: false, code: 'unauthenticated', message: 'Please sign in again.', correlationId };
    }
    const result = await withActor({ authUserId: viewer.authUserId, correlationId }, ({ tx }) =>
      fn({ tx, viewer, correlationId }),
    );
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof DomainError) {
      return { ok: false, code: error.code, message: error.message, correlationId };
    }
    if (isZodError(error)) {
      return {
        ok: false,
        code: 'validation_failed',
        message: 'Please correct the highlighted fields.',
        correlationId,
        fieldErrors: flattenZodErrors(error),
      };
    }
    // Everything unexpected is logged with the correlation id and reported
    // generically: raw database text can leak schema and personal data.
    console.error(JSON.stringify({
      level: 'error', correlationId,
      message: error instanceof Error ? error.message : 'unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }));
    return {
      ok: false,
      code: 'internal',
      message: 'Something went wrong and the change was not saved. Nothing was partially applied.',
      correlationId,
    };
  }
}

interface ZodLike { name?: string; issues?: Array<{ path: Array<string | number>; message: string }> }

function isZodError(error: unknown): error is Required<ZodLike> {
  const e = error as ZodLike;
  return Array.isArray(e?.issues);
}

function flattenZodErrors(error: Required<ZodLike>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_form';
    (out[key] ??= []).push(issue.message);
  }
  return out;
}
