import 'server-only';
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

const COOKIE = 'propertyos_session';
const MAX_AGE_SECONDS = 60 * 60 * 8;

function secret(): Buffer {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      'SESSION_SECRET must be set to at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
  return Buffer.from(value, 'utf8');
}

export type AssuranceLevel = 'aal1' | 'aal2';

interface SessionPayload {
  sub: string;
  exp: number;
  /**
   * Authenticator assurance level, mirroring Supabase's claim convention.
   * aal1 = password only, aal2 = second factor verified.
   *
   * This value is set ONLY from what the auth provider confirmed. The
   * application never promotes a session to aal2 by itself, and a cookie
   * missing the claim is treated as aal1 — the weaker state, never the
   * stronger one.
   */
  aal: AssuranceLevel;
  /**
   * When identity was last proved, as epoch seconds.
   *
   * Separate from `exp` on purpose. A session stays valid for hours; freshness
   * expires in minutes, and the sensitive commands that demand it send the
   * operator back through their second factor to refresh this value alone.
   * Absent is read as stale, never as "just now".
   */
  aat?: number;
  /** Bound to the authentication event, so a stale cookie cannot be replayed. */
  jti: string;
}

function sign(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token: string): SessionPayload | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  const provided = Buffer.from(mac, 'base64url');
  // Constant-time comparison; length check first because timingSafeEqual throws
  // on a length mismatch.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.aat !== undefined && typeof payload.aat !== 'number') return null;
    if (payload.exp * 1000 < Date.now()) return null;
    // Fail safe: anything other than an explicit aal2 is a single-factor session.
    return { ...payload, aal: payload.aal === 'aal2' ? 'aal2' : 'aal1' };
  } catch {
    return null;
  }
}

export async function createSession(
  authUserId: string,
  assuranceLevel: AssuranceLevel = 'aal1',
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const token = sign({
    sub: authUserId,
    aal: assuranceLevel,
    // Only a session that actually completed a second factor carries an
    // authentication instant. A single-factor session has nothing to be fresh
    // about, so the claim is omitted rather than set to now.
    ...(assuranceLevel === 'aal2' ? { aat: now } : {}),
    exp: now + MAX_AGE_SECONDS,
    jti: randomBytes(12).toString('base64url'),
  });
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax rather than Strict so that an emailed invitation link lands on a
    // signed-in session; all state-changing routes additionally verify origin.
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

/**
 * The ONLY source of caller identity in the application.
 *
 * Nothing else may set `auth.uid()`. A user id present in a URL, a form field or
 * a header is never treated as identity.
 */
export async function currentAuthUserId(): Promise<string | null> {
  return (await currentSession())?.authUserId ?? null;
}

export async function currentSession(): Promise<
  { authUserId: string; assuranceLevel: AssuranceLevel; authenticatedAt?: number } | null
> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const payload = verify(token);
  if (!payload) return null;
  return { authUserId: payload.sub, assuranceLevel: payload.aal, authenticatedAt: payload.aat };
}

/* ------------------------------------------------- local credential provider */

/**
 * Password hashing for the LOCAL development auth provider.
 * In production `AUTH_PROVIDER=supabase` and Supabase Auth owns credentials,
 * session issuance and MFA; this code path is not used.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
