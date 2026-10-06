/**
 * Sealing personal identifiers at rest.
 *
 * A lease agreement has to state a full identity number and a full bank account
 * number. The schema deliberately kept only the last four digits of each, which
 * is right for a screen and useless for a signable document — so the full value
 * is stored sealed, and opened only at the moment an agreement is generated.
 *
 * AES-256-GCM, so the ciphertext is authenticated: a tampered value fails to
 * open rather than decrypting to something else. The key comes from the
 * environment and is never written to the database, so a dump of the database
 * on its own discloses nothing.
 *
 * What this is NOT: it is not protection against an attacker who already has
 * both the database and the application environment, and it is not a substitute
 * for the permission check and audit record that must accompany every opening.
 * Those live in the domain layer.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERSION = 1;

export class SealedFieldError extends Error {}

/**
 * Reads the key, failing loudly rather than falling back to anything weaker.
 * An unset key must stop a lease being generated, not produce one with the
 * identity number silently missing.
 */
export function readSealingKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.FIELD_ENCRYPTION_KEY;
  if (!raw) {
    throw new SealedFieldError(
      'FIELD_ENCRYPTION_KEY is not set. Identity and bank numbers cannot be sealed or ' +
        'opened without it. Generate one with: openssl rand -base64 32',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new SealedFieldError('FIELD_ENCRYPTION_KEY is not valid base64.');
  }
  if (key.length !== KEY_BYTES) {
    throw new SealedFieldError(
      `FIELD_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: openssl rand -base64 32',
    );
  }
  return key;
}

export function sealingKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    readSealingKey(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * `context` binds the ciphertext to the row it belongs to (as additional
 * authenticated data), so a sealed value lifted from one resident's row cannot
 * be pasted into another's and still open.
 */
export function sealField(plaintext: string, context: string, env?: NodeJS.ProcessEnv): Buffer {
  if (plaintext.length === 0) throw new SealedFieldError('Refusing to seal an empty value.');
  const key = readSealingKey(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // version | iv | tag | ciphertext
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, body]);
}

export function openField(sealed: Buffer | Uint8Array, context: string, env?: NodeJS.ProcessEnv): string {
  const buffer = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed);
  if (buffer.length < 1 + IV_BYTES + TAG_BYTES + 1) {
    throw new SealedFieldError('Sealed value is too short to be valid.');
  }
  if (buffer[0] !== VERSION) {
    throw new SealedFieldError(`Unsupported sealed field version ${buffer[0]}.`);
  }
  const key = readSealingKey(env);
  const iv = buffer.subarray(1, 1 + IV_BYTES);
  const tag = buffer.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = buffer.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new SealedFieldError(
      'Sealed value failed authentication. It was altered, sealed under a different key, ' +
        'or belongs to a different record.',
    );
  }
}

/** The last four digits kept alongside the sealed value, for display. */
export function lastFour(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.slice(-4).padStart(4, '0');
}

/** Masks a value for anything that is written down: logs, snapshots, audit. */
export function maskIdentifier(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return '•'.repeat(digits.length);
  return `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

/** Constant-time comparison, for confirming a re-entered number matches. */
export function sameIdentifier(a: string, b: string): boolean {
  const left = Buffer.from(a.replace(/\D/g, ''), 'utf8');
  const right = Buffer.from(b.replace(/\D/g, ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
