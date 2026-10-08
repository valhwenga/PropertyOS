/**
 * Where to send the operator after they re-verify.
 *
 * In its own module because `actions.ts` is a `'use server'` file, where every
 * export must be an async Server Action. A synchronous helper exported from
 * there compiles, type-checks and lints cleanly, then fails at runtime — and it
 * takes the whole application down with it, because the broken module is
 * imported by a page.
 */

/**
 * Only a path inside this application, and never the re-authentication page
 * itself.
 *
 * `returnTo` arrives from a query string, so it is attacker-controlled. A bare
 * redirect to it is an open redirect, and "//evil.example" is a protocol
 * relative URL that most naive checks let through: it starts with a slash and
 * is not a path.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/app';
  // A backslash is treated as a slash by some browsers when resolving, so
  // "/\evil.example" can escape too.
  if (value.startsWith('/\\')) return '/app';
  // Sending someone back here after re-verifying would loop.
  if (value.startsWith('/reauthenticate')) return '/app';
  return value;
}
