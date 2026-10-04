/**
 * Authentication provider adapter.
 *
 * Two implementations behind one interface:
 *
 *  - `supabase` — production. Supabase Auth owns credential storage, password
 *    policy, rate limiting and MFA enrolment/verification.
 *  - `local`    — development and tests. Credentials and TOTP factors live in
 *    the database so that the whole authorisation model, including MFA
 *    enforcement, is exercisable without a Supabase project.
 *
 * Both return the same `AuthResult`, and in both cases the assurance level that
 * reaches the session cookie is the one the PROVIDER confirmed. The application
 * never upgrades a session to aal2 on its own.
 */

export type AssuranceLevel = 'aal1' | 'aal2';

export type AuthResult =
  | { status: 'authenticated'; authUserId: string; assuranceLevel: AssuranceLevel }
  | { status: 'mfa_required'; authUserId: string; challengeId: string }
  | { status: 'rejected'; reason: 'bad_credentials' | 'rate_limited' | 'mfa_failed' | 'unavailable'; detail?: string };

export interface AuthProvider {
  readonly name: 'supabase' | 'local';
  /** True when this provider can verify a second factor. */
  readonly supportsMfa: boolean;
}

export function resolveAuthProviderName(env: NodeJS.ProcessEnv = process.env): 'supabase' | 'local' {
  return env.AUTH_PROVIDER === 'supabase' ? 'supabase' : 'local';
}

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
}

export function supabaseAuthConfig(env: NodeJS.ProcessEnv = process.env): SupabaseAuthConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/**
 * Signs in against Supabase Auth over its public REST endpoints.
 *
 * Deliberately uses the ANON key only. The service role key bypasses Row Level
 * Security and must never be used on a request path; it is not read here at all.
 *
 * Supabase reports the session's assurance level through the `aal` claim of the
 * access token. We read it rather than inferring it: if Supabase says the
 * session is aal1, it is aal1, whatever we think should have happened.
 */
export async function supabaseSignIn(
  config: SupabaseAuthConfig,
  credentials: { email: string; password: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AuthResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
    });
  } catch (error) {
    return {
      status: 'rejected',
      reason: 'unavailable',
      detail: error instanceof Error ? error.message : 'Supabase Auth could not be reached.',
    };
  }

  if (response.status === 429) return { status: 'rejected', reason: 'rate_limited' };
  if (!response.ok) return { status: 'rejected', reason: 'bad_credentials' };

  const payload = (await response.json()) as {
    access_token?: string;
    user?: { id?: string; factors?: Array<{ status?: string }> };
  };
  const userId = payload.user?.id;
  const token = payload.access_token;
  if (!userId || !token) return { status: 'rejected', reason: 'bad_credentials' };

  const claims = decodeJwtClaims(token);
  const aal = claims?.aal === 'aal2' ? 'aal2' : 'aal1';

  // If the account has a verified factor but the session is still aal1, Supabase
  // expects an MFA challenge before the session is fully assured.
  const hasVerifiedFactor = (payload.user?.factors ?? []).some((f) => f.status === 'verified');
  if (hasVerifiedFactor && aal === 'aal1') {
    return { status: 'mfa_required', authUserId: userId, challengeId: token };
  }

  return { status: 'authenticated', authUserId: userId, assuranceLevel: aal };
}

/** Verifies a Supabase MFA challenge, returning the upgraded assurance level. */
export async function supabaseVerifyMfa(
  config: SupabaseAuthConfig,
  params: { accessToken: string; factorId: string; challengeId: string; code: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AuthResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.url}/auth/v1/factors/${params.factorId}/verify`, {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ challenge_id: params.challengeId, code: params.code }),
    });
  } catch (error) {
    return {
      status: 'rejected',
      reason: 'unavailable',
      detail: error instanceof Error ? error.message : 'Supabase Auth could not be reached.',
    };
  }

  if (!response.ok) return { status: 'rejected', reason: 'mfa_failed' };

  const payload = (await response.json()) as { access_token?: string; user?: { id?: string } };
  if (!payload.access_token || !payload.user?.id) {
    return { status: 'rejected', reason: 'mfa_failed' };
  }
  const claims = decodeJwtClaims(payload.access_token);
  // Only Supabase can declare aal2. If it did not, we do not.
  if (claims?.aal !== 'aal2') return { status: 'rejected', reason: 'mfa_failed' };

  return { status: 'authenticated', authUserId: payload.user.id, assuranceLevel: 'aal2' };
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
