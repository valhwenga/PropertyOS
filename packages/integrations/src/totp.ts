import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), used by the LOCAL development auth
 * provider. In production `AUTH_PROVIDER=supabase` and Supabase Auth owns
 * enrolment and verification; this implementation exists so that MFA is real and
 * testable without a Supabase project, not as a replacement for it.
 *
 * Replay protection is NOT handled here: a verified code returns its time step
 * so the caller can record it and refuse the same step twice.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20): string {
  const buffer = randomBytes(bytes);
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let secret = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    secret += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return secret;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character in TOTP secret.');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function timeStep(at: number = Date.now(), period = 30): number {
  return Math.floor(at / 1000 / period);
}

export function generateCode(secret: string, step: number = timeStep(), digits = 6): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export interface TotpVerification {
  valid: boolean;
  /** The step the code matched, so the caller can prevent replay. */
  step?: number;
}

/**
 * Verifies a code, allowing one step either side for clock drift.
 * Comparison is constant time so a code cannot be recovered by timing.
 */
export function verifyCode(
  secret: string,
  code: string,
  options: { at?: number; window?: number; digits?: number } = {},
): TotpVerification {
  const digits = options.digits ?? 6;
  const normalised = code.replace(/\D/g, '');
  if (normalised.length !== digits) return { valid: false };

  const current = timeStep(options.at ?? Date.now());
  const window = options.window ?? 1;
  const provided = Buffer.from(normalised, 'utf8');

  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    const expected = Buffer.from(generateCode(secret, step, digits), 'utf8');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

/** The otpauth:// URI an authenticator app scans. */
export function enrolmentUri(params: { secret: string; account: string; issuer?: string }): string {
  const issuer = params.issuer ?? 'Spike PropertyOS';
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(params.account)}` +
    `?secret=${params.secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}
