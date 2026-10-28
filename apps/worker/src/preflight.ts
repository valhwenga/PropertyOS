/**
 * Deployment preflight.
 *
 *   pnpm preflight              read the configuration and report on it
 *   pnpm preflight --probe      also contact the services it is pointed at
 *   pnpm preflight --strict     treat every gap as a failure (exit non-zero)
 *
 * This answers one question before a deploy or a staging rehearsal: which of
 * the production-intended adapters are actually configured here, and which are
 * standing in for one?
 *
 * The distinction the whole file turns on is the one `docs/MVP-RECONCILIATION.md`
 * calls *Tested* versus *External*. A configured adapter has never been shown
 * to work; only a contacted one has. So without `--probe` nothing is reported
 * as reachable, with `--probe` the result says what was actually exchanged, and
 * in neither case is "configured" printed as though it meant "working".
 *
 * `--probe` makes real network connections to the services in this environment's
 * own configuration, using the credentials it was given. It does not send an
 * email, scan a file, or write a customer record: SMTP is taken as far as
 * authentication and then QUIT, clamd is asked for its signature version, and
 * object storage round-trips one object under a preflight/ key and deletes it.
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import {
  SinkEmailAdapter,
  SmtpEmailAdapter,
  pingClamAv,
  resolveAuthProviderName,
  resolveEmailAdapter,
  resolvePaymentProvider,
  resolveStorageAdapter,
  supabaseAuthConfig,
  verifySmtpConnection,
} from '@propertyos/integrations';

const probe = process.argv.includes('--probe');
const strict = process.argv.includes('--strict');

type Level = 'pass' | 'gap' | 'fail' | 'info';

interface Finding {
  section: string;
  level: Level;
  label: string;
  detail: string;
}

const findings: Finding[] = [];
let section = '';

function heading(name: string): void {
  section = name;
}

function record(level: Level, label: string, detail: string): void {
  findings.push({ section, level, label, detail });
}

/** Loads .env.local the way the other CLIs do, without overriding the shell. */
function loadLocalEnv(): void {
  if (process.env.APP_DATABASE_URL || process.env.DATABASE_URL) return;
  const envFile = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Absent or unreadable: every check below reports the missing variable
    // itself, which is the accurate complaint.
  }
}

/* ------------------------------------------------------------------ database */

async function checkDatabase(): Promise<void> {
  heading('Database');

  const appUrl = process.env.APP_DATABASE_URL;
  if (!appUrl) {
    record('fail', 'APP_DATABASE_URL', 'Not set. The application refuses to start without an RLS-enforced connection.');
    return;
  }

  const sql = postgres(appUrl, { max: 1, onnotice: () => {} });
  try {
    const [role] = await sql<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }[]>`
      select current_user, r.rolsuper, r.rolbypassrls
        from pg_roles r where r.rolname = current_user
    `;
    if (!role) throw new Error('The database did not report the connected role.');
    record('pass', 'application connection', `connected as ${role.current_user}`);

    if (role.rolsuper || role.rolbypassrls) {
      record(
        'fail',
        'tenant isolation',
        `${role.current_user} is ${role.rolsuper ? 'a superuser' : 'BYPASSRLS'}. ` +
          'Row Level Security would not apply to a single request. The application refuses to start.',
      );
    } else {
      record('pass', 'tenant isolation', 'the application role is neither a superuser nor BYPASSRLS');
    }

    // Pending migrations are the difference between a deploy that works and one
    // that answers "column does not exist" to the first person who clicks.
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(here, '..', '..', '..', 'packages', 'db', 'migrations');
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const applied = await sql<{ filename: string }[]>`select filename from schema_migrations`;
    const appliedNames = new Set(applied.map((r) => r.filename));
    const pending = files.filter((f) => !appliedNames.has(f));
    if (pending.length === 0) {
      record('pass', 'migrations', `${files.length} applied, none pending`);
    } else {
      record('fail', 'migrations', `${pending.length} not applied: ${pending.join(', ')}. Run pnpm db:migrate.`);
    }
  } catch (error) {
    record('fail', 'application connection', (error as Error).message);
  } finally {
    await sql.end({ timeout: 5 });
  }

  if (!process.env.DATABASE_URL) {
    record('gap', 'DATABASE_URL', 'Not set. Migrations and the worker need the owner connection; the web app must not have it.');
  } else if (process.env.DATABASE_URL === process.env.APP_DATABASE_URL) {
    record('fail', 'DATABASE_URL', 'Identical to APP_DATABASE_URL. The privilege boundary between them is the point of having two.');
  } else {
    record('pass', 'DATABASE_URL', 'set, and distinct from the application connection');
  }
}

/* ------------------------------------------------------------------- secrets */

function checkSecrets(): void {
  heading('Secrets');

  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (sessionSecret.length >= 32) {
    record('pass', 'SESSION_SECRET', `${sessionSecret.length} characters`);
  } else {
    record('fail', 'SESSION_SECRET', `${sessionSecret.length} characters; 32 or more are required to sign session cookies.`);
  }

  const fieldKey = process.env.FIELD_ENCRYPTION_KEY ?? '';
  if (!fieldKey) {
    record(
      'gap',
      'FIELD_ENCRYPTION_KEY',
      'Not set. Identity and bank account numbers cannot be stored or read, and a generated agreement ' +
        'reports them incomplete rather than inventing anything.',
    );
  } else {
    const bytes = Buffer.from(fieldKey, 'base64').length;
    if (bytes === 32) record('pass', 'FIELD_ENCRYPTION_KEY', '32 bytes');
    else record('fail', 'FIELD_ENCRYPTION_KEY', `decodes to ${bytes} bytes; AES-256-GCM needs exactly 32.`);
  }

  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    record(
      'info',
      'SUPABASE_SERVICE_ROLE_KEY',
      'Present in this process. It bypasses Row Level Security: it belongs to the worker and to object ' +
        'storage, and must never be reachable from a web request path.',
    );
  }
}

/* ------------------------------------------------------------ authentication */

async function checkAuth(): Promise<void> {
  heading('Authentication');

  const provider = resolveAuthProviderName();
  if (provider === 'local') {
    record(
      'gap',
      'AUTH_PROVIDER=local',
      'Credentials and TOTP factors live in this database. Development and tests only — set ' +
        'AUTH_PROVIDER=supabase for a deployment.',
    );
    return;
  }

  const config = supabaseAuthConfig();
  if (!config) {
    record('fail', 'AUTH_PROVIDER=supabase', 'NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required with it.');
    return;
  }
  record('pass', 'AUTH_PROVIDER=supabase', `configured for ${config.url}`);

  if (!probe) {
    record('info', 'Supabase Auth', 'configured, not contacted (run with --probe)');
    return;
  }
  try {
    const response = await fetch(new URL('/auth/v1/health', config.url), {
      headers: { apikey: config.anonKey },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) record('pass', 'Supabase Auth reachable', `${response.status} from ${config.url}`);
    else record('fail', 'Supabase Auth reachable', `${response.status} ${response.statusText} from ${config.url}`);
  } catch (error) {
    record('fail', 'Supabase Auth reachable', (error as Error).message);
  }

  // Re-verification for sensitive changes is implemented for the local provider
  // only, and refuses rather than silently granting freshness under Supabase.
  record(
    'gap',
    're-verification under Supabase',
    'Sensitive changes that require fresh authentication refuse with an explanation under this provider. ' +
      'See docs/known-limitations.md.',
  );
}

/* --------------------------------------------------------------------- email */

async function checkEmail(): Promise<void> {
  heading('Email');

  const adapter = resolveEmailAdapter();
  if (!(adapter instanceof SmtpEmailAdapter)) {
    const reason = adapter instanceof SinkEmailAdapter ? adapter.reason : '';
    record(
      'gap',
      'no delivery configured',
      `Messages are recorded as 'development_sink' and NEVER reported as sent. ${reason}`.trim(),
    );
    return;
  }

  const host = process.env.SMTP_HOST!;
  const port = Number(process.env.SMTP_PORT);
  record('pass', 'EMAIL_PROVIDER=smtp', `configured for ${host}:${port}, from ${process.env.EMAIL_FROM}`);

  if (process.env.SMTP_ALLOW_SELF_SIGNED === 'true') {
    record('fail', 'SMTP_ALLOW_SELF_SIGNED', 'true. Certificate verification is disabled; this is a development setting only.');
  }

  if (!probe) {
    record('info', 'SMTP server', 'configured, not contacted (run with --probe)');
  } else {
    try {
      await verifySmtpConnection({
        host,
        port,
        user: process.env.SMTP_USER!,
        password: process.env.SMTP_PASSWORD!,
        from: process.env.EMAIL_FROM!,
        secure: port === 465,
        rejectUnauthorized: process.env.SMTP_ALLOW_SELF_SIGNED !== 'true',
      });
      record('pass', 'SMTP server reachable', `${host}:${port} accepted the credentials (nothing was sent)`);
    } catch (error) {
      record('fail', 'SMTP server reachable', (error as Error).message);
    }
  }

  // Nothing here can check these, and a deployment that skips them has
  // deliverable-looking mail that lands in spam folders.
  record(
    'gap',
    'sender domain authentication',
    'SPF, DKIM and DMARC for the sending domain, and bounce and complaint handling, are not verifiable from ' +
      'here and have not been set up. See docs/pilot-readiness.md.',
  );
}

/* ---------------------------------------------------------- malware scanning */

async function checkScanner(): Promise<void> {
  heading('Malware scanning');

  const scanner = process.env.MALWARE_SCANNER;
  if (!scanner) {
    record(
      'gap',
      'MALWARE_SCANNER unset',
      'Uploads are recorded as skipped_not_configured and stay quarantined, so no document can be shared. ' +
        'Nothing is ever reported as scanned.',
    );
    return;
  }
  if (scanner !== 'clamav') {
    record('fail', `MALWARE_SCANNER=${scanner}`, 'Unsupported. Supported value: clamav. Every upload would fail its scan and stay quarantined.');
    return;
  }

  const host = process.env.CLAMAV_HOST ?? '127.0.0.1';
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  record('pass', 'MALWARE_SCANNER=clamav', `configured for ${host}:${port}`);

  if (!probe) {
    record('info', 'clamd', 'configured, not contacted (run with --probe)');
    return;
  }
  const result = await pingClamAv({ host, port, timeoutMs: Number(process.env.CLAMAV_TIMEOUT_MS ?? 5_000) });
  if (result.status === 'available') record('pass', 'clamd reachable', result.version);
  else record('fail', 'clamd reachable', `${result.detail} Every upload would stay quarantined.`);
}

/* ------------------------------------------------------------------- storage */

async function checkStorage(): Promise<void> {
  heading('Document storage');

  let adapter;
  try {
    adapter = resolveStorageAdapter();
  } catch (error) {
    record('fail', 'storage adapter', (error as Error).message);
    return;
  }

  if (adapter.name === 'local') {
    record(
      'gap',
      'local filesystem storage',
      `Objects live under ${process.env.LOCAL_STORAGE_ROOT ?? '.storage'} on this machine. A deployment ` +
        'needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for a private bucket.',
    );
  } else {
    record('pass', 'Supabase Storage', `private bucket ${process.env.SUPABASE_STORAGE_BUCKET ?? 'propertyos-private'}`);
  }

  if (!probe) {
    record('info', 'object store', 'configured, not contacted (run with --probe)');
    return;
  }
  const key = `preflight/${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  const body = Buffer.from('PropertyOS preflight. Safe to delete.', 'utf8');
  try {
    await adapter.put({ key, body, contentType: 'text/plain' });
    const read = await adapter.get(key);
    if (Buffer.from(read).equals(body)) record('pass', 'object store round-trip', 'wrote, read back and removed one object');
    else record('fail', 'object store round-trip', 'the object read back did not match what was written.');
    await adapter.remove(key);
  } catch (error) {
    record('fail', 'object store round-trip', (error as Error).message);
  }
}

/* -------------------------------------------------------------- application */

function checkApplication(): void {
  heading('Application');

  const baseUrl = process.env.APP_BASE_URL;
  if (!baseUrl) {
    record('fail', 'APP_BASE_URL', 'Not set. Invitation and download links would be built against the wrong origin.');
  } else if (process.env.NODE_ENV === 'production' && !baseUrl.startsWith('https://')) {
    record('fail', 'APP_BASE_URL', `${baseUrl} is not https. Session cookies and signed links would travel in the clear.`);
  } else {
    record('pass', 'APP_BASE_URL', baseUrl);
  }

  record('info', 'locale', `${process.env.DEFAULT_CURRENCY ?? 'ZAR'} / ${process.env.DEFAULT_TIME_ZONE ?? 'Africa/Johannesburg'} / ${process.env.DEFAULT_COUNTRY ?? 'ZA'}`);

  if (process.env.RENT_PAYMENT_PROVIDER_ENABLED === 'true') {
    record(
      'fail',
      'RENT_PAYMENT_PROVIDER_ENABLED',
      'true. No rent payment provider is implemented, and none may be enabled before merchant ownership, ' +
        'settlement destination and funds custody are confirmed in writing. See docs/decisions/0004.',
    );
  } else {
    record('pass', 'rent payment provider', 'disabled, as it must be until merchant ownership is confirmed');
  }

  // Spike's OWN collection, which ADR 0004 keeps as a separate money flow and
  // does not prohibit. The failure mode worth refusing to start over: a
  // deployment configured to take payments through an adapter that is not
  // implemented would show customers a Pay button that cannot work.
  const payments = resolvePaymentProvider();
  if (payments.name === 'none') {
    record(
      'info',
      'subscription payments',
      "no provider: Spike's invoices are settled by hand from its bank statement",
    );
  } else if (!payments.available) {
    record(
      'fail',
      'SUBSCRIPTION_PAYMENT_PROVIDER',
      `${payments.name}, which cannot be used: ${payments.unavailableReason}`,
    );
  } else if (payments.name === 'sandbox') {
    record(
      'gap',
      'subscription payments',
      'SANDBOX provider. Notifications are signed and verified by this product itself and '
        + 'no money moves. Never use this with real customers.',
    );
  } else {
    record('pass', 'subscription payments', `${payments.name}`);
  }
}

/* -------------------------------------------------------------------- output */

const MARK: Record<Level, string> = { pass: 'PASS', gap: 'GAP ', fail: 'FAIL', info: '    ' };

async function main(): Promise<void> {
  loadLocalEnv();

  process.stdout.write('Spike PropertyOS — deployment preflight\n');
  process.stdout.write(
    `NODE_ENV=${process.env.NODE_ENV ?? 'unset'}  revision=${process.env.APP_REVISION ?? 'unknown'}  ` +
      `${probe ? 'contacting configured services' : 'reading configuration only (--probe to contact services)'}\n`,
  );

  await checkDatabase();
  checkSecrets();
  await checkAuth();
  await checkEmail();
  await checkScanner();
  await checkStorage();
  checkApplication();

  let current = '';
  for (const finding of findings) {
    if (finding.section !== current) {
      current = finding.section;
      process.stdout.write(`\n${current.toUpperCase()}\n`);
    }
    process.stdout.write(`  ${MARK[finding.level]}  ${finding.label.padEnd(32)} ${finding.detail}\n`);
  }

  const failures = findings.filter((f) => f.level === 'fail');
  const gaps = findings.filter((f) => f.level === 'gap');

  process.stdout.write(`\n${failures.length} failure(s), ${gaps.length} gap(s).\n`);
  if (gaps.length > 0) {
    process.stdout.write(
      'A gap is a production-intended capability that is absent here. The product says so honestly where\n' +
        'it matters — undelivered mail is never recorded as sent, an unscanned file is never shared — but\n' +
        'the capability is missing, and a pilot needs it closed. See docs/credentials.md.\n',
    );
  }
  if (!probe) {
    process.stdout.write(
      'Nothing above was contacted, so nothing above is known to work. Re-run with --probe in the target\n' +
        'environment before relying on any of it.\n',
    );
  }

  process.exit(failures.length > 0 || (strict && gaps.length > 0) ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`preflight failed: ${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
