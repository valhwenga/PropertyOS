import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';

/**
 * Private object storage.
 *
 * Two implementations behind one interface:
 *
 *  - `SupabaseStorage` — production. A PRIVATE bucket, with short-lived signed
 *    URLs minted server side. The service role key is used only here and only on
 *    the server; it must never reach the browser.
 *  - `LocalFilesystemStorage` — development and tests. Files live under a
 *    directory that is not served by the web server; "signed URLs" are HMAC
 *    tokens redeemed by our own download route, so the permission model is
 *    identical in both environments.
 *
 * Neither implementation decides WHO may download. That is settled by
 * `authoriseDownload` in the domain layer, under the caller's own RLS context,
 * before a URL is ever minted.
 */

export interface StoredObject {
  bucket: string;
  key: string;
  byteSize: number;
}

export interface SignedDownload {
  url: string;
  expiresAt: Date;
}

export interface StorageAdapter {
  readonly name: 'supabase' | 'local';
  put(params: { key: string; body: Uint8Array; contentType: string }): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  signedDownload(params: { key: string; ttlSeconds: number; filename?: string }): Promise<SignedDownload>;
  remove(key: string): Promise<void>;
}

/** Rejects traversal and absolute paths before any key reaches the filesystem. */
export function assertSafeKey(key: string): void {
  if (!key || key.length > 1024) throw new Error('Invalid storage key.');
  if (key.startsWith('/') || key.includes('\\')) throw new Error('Invalid storage key.');
  const normalised = normalize(key);
  if (normalised.startsWith('..') || normalised.includes(`..${sep}`)) {
    throw new Error('Invalid storage key.');
  }
}

/* ----------------------------------------------------------------- local */

export class LocalFilesystemStorage implements StorageAdapter {
  readonly name = 'local';

  constructor(
    private readonly root: string,
    private readonly secret: string,
    private readonly baseUrl: string,
  ) {
    if (secret.length < 32) {
      throw new Error('Local storage signing secret must be at least 32 characters.');
    }
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    // Belt and braces: the resolved path must still be inside the root.
    if (!full.startsWith(resolve(this.root) + sep)) {
      throw new Error('Invalid storage key.');
    }
    return full;
  }

  async put(params: { key: string; body: Uint8Array; contentType: string }): Promise<StoredObject> {
    const path = this.pathFor(params.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.body, { mode: 0o600 });
    return { bucket: 'local', key: params.key, byteSize: params.body.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  async signedDownload(params: {
    key: string; ttlSeconds: number; filename?: string;
  }): Promise<SignedDownload> {
    assertSafeKey(params.key);
    const expires = Math.floor(Date.now() / 1000) + params.ttlSeconds;
    const token = signObjectToken(this.secret, params.key, expires);
    const query = new URLSearchParams({ key: params.key, expires: String(expires), token });
    if (params.filename) query.set('filename', params.filename);
    return {
      url: `${this.baseUrl}/documents/object?${query.toString()}`,
      expiresAt: new Date(expires * 1000),
    };
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export function signObjectToken(secret: string, key: string, expiresUnix: number): string {
  return createHmac('sha256', secret).update(`${key}:${expiresUnix}`).digest('base64url');
}

/**
 * Verifies a local download token.
 * Constant-time comparison, and expiry checked before anything is read.
 */
export function verifyObjectToken(
  secret: string,
  params: { key: string; expiresUnix: number; token: string },
): { valid: boolean; reason?: 'expired' | 'bad_signature' } {
  if (params.expiresUnix * 1000 < Date.now()) return { valid: false, reason: 'expired' };
  const expected = Buffer.from(signObjectToken(secret, params.key, params.expiresUnix), 'utf8');
  const provided = Buffer.from(params.token, 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { valid: false, reason: 'bad_signature' };
  }
  return { valid: true };
}

/* -------------------------------------------------------------- supabase */

export class SupabaseStorage implements StorageAdapter {
  readonly name = 'supabase';

  constructor(
    private readonly config: { url: string; serviceRoleKey: string; bucket: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!config.serviceRoleKey) {
      throw new Error('SupabaseStorage requires a service role key. It is SERVER ONLY.');
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      apikey: this.config.serviceRoleKey,
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
      ...extra,
    };
  }

  async put(params: { key: string; body: Uint8Array; contentType: string }): Promise<StoredObject> {
    assertSafeKey(params.key);
    const response = await this.fetchImpl(
      `${this.config.url}/storage/v1/object/${this.config.bucket}/${encodeURI(params.key)}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': params.contentType, 'x-upsert': 'false' }),
        body: params.body as unknown as BodyInit,
      },
    );
    if (!response.ok) {
      throw new Error(`Storage upload failed with status ${response.status}.`);
    }
    return { bucket: this.config.bucket, key: params.key, byteSize: params.body.byteLength };
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    const response = await this.fetchImpl(
      `${this.config.url}/storage/v1/object/${this.config.bucket}/${encodeURI(key)}`,
      { headers: this.headers() },
    );
    if (!response.ok) throw new Error(`Storage read failed with status ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async signedDownload(params: {
    key: string; ttlSeconds: number; filename?: string;
  }): Promise<SignedDownload> {
    assertSafeKey(params.key);
    const response = await this.fetchImpl(
      `${this.config.url}/storage/v1/object/sign/${this.config.bucket}/${encodeURI(params.key)}`,
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: params.ttlSeconds }),
      },
    );
    if (!response.ok) throw new Error(`Could not sign a download URL (status ${response.status}).`);
    const payload = (await response.json()) as { signedURL?: string };
    if (!payload.signedURL) throw new Error('Storage did not return a signed URL.');
    return {
      url: `${this.config.url}/storage/v1${payload.signedURL}`,
      expiresAt: new Date(Date.now() + params.ttlSeconds * 1000),
    };
  }

  async remove(key: string): Promise<void> {
    assertSafeKey(key);
    await this.fetchImpl(
      `${this.config.url}/storage/v1/object/${this.config.bucket}/${encodeURI(key)}`,
      { method: 'DELETE', headers: this.headers() },
    );
  }
}

/**
 * Resolves the adapter from the environment.
 *
 * Falls back to local filesystem storage when Supabase is not configured, and
 * says so. It never silently no-ops: a storage call that cannot be satisfied
 * throws rather than pretending a file was saved.
 */
export function resolveStorageAdapter(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = env.SUPABASE_STORAGE_BUCKET ?? 'propertyos-private';

  if (url && serviceRoleKey) {
    return new SupabaseStorage({ url, serviceRoleKey, bucket });
  }
  const root = env.LOCAL_STORAGE_ROOT ?? '.storage';
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length < 32) {
    throw new Error(
      'Local storage requires SESSION_SECRET (32+ characters) to sign download URLs, ' +
        'or configure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for Supabase Storage.',
    );
  }
  return new LocalFilesystemStorage(root, secret, env.APP_BASE_URL ?? 'http://localhost:3000');
}
