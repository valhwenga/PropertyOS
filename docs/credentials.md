# Credentials and external services

What PropertyOS needs to run, who owns each thing, and — the column that
matters — whether it has ever been exercised against the real service.

`pnpm preflight` reads this environment and reports the same ground truth for
the machine it runs on. `pnpm preflight --probe` additionally contacts the
services it is pointed at, without sending mail, scanning a file or writing a
customer record. Nothing it reports as configured is claimed to work: only a
`--probe` run says that, and only about what it actually reached.

## How to read the exercised column

| | Means |
| --- | --- |
| **Real service** | Contacted the actual third-party service, with its credentials, and the path worked. |
| **Local only** | Exercised against a local stand-in — an in-process SMTP server, a mock daemon, a local database. The code is tested; the provider is not. |
| **Never** | No code path has run against it. |

As of 17 October 2026, **no row reads "Real service"**. No external provider has
ever been contacted from this codebase. Blueprint §24's qualification column is
unanswered for every integration, and that is the single largest gap between
this build and a pilot.

## The register

### Database — required, no fallback

| Variable | Owner | Enables | Without it | Exercised |
| --- | --- | --- | --- | --- |
| `APP_DATABASE_URL` | Technical lead | Every request-scoped query, with RLS in force | The application refuses to start. There is deliberately no fallback to the owner connection, because a misconfiguration must not become a silent loss of tenant isolation | Local only |
| `DATABASE_URL` | Technical lead | Migrations and the worker's job claiming | Migrations cannot run; the worker cannot claim jobs | Local only |

The role behind `APP_DATABASE_URL` must be neither a superuser nor hold
`BYPASSRLS`. The application asserts this at startup, `/healthz` asserts it on
every probe, and `pnpm preflight` asserts it before a deploy.

### Secrets — required

| Variable | Owner | Enables | Without it | Exercised |
| --- | --- | --- | --- | --- |
| `SESSION_SECRET` | Technical lead | Signed session cookies and signed download links | Sessions cannot be issued; local object storage refuses to mint a URL | Local only |
| `FIELD_ENCRYPTION_KEY` | Technical lead | Sealed identity and bank account numbers (AES-256-GCM, 32 bytes base64) | Those fields cannot be stored or read. A generated lease agreement reports them incomplete rather than inventing anything, and a resident cannot be shown the full collection account number | Local only |

Both are generated per environment and stored in a managed secret store. A
rotated `FIELD_ENCRYPTION_KEY` cannot open what the previous key sealed: plan
re-sealing before rotating, or the sealed fields are lost.

### Authentication

| Variable | Owner | Enables | Without it | Exercised |
| --- | --- | --- | --- | --- |
| `AUTH_PROVIDER` | Technical lead | `supabase` in production; `local` for development | Defaults to `local`, which keeps credentials and TOTP factors in this database — development and tests only | Local only |
| `NEXT_PUBLIC_SUPABASE_URL` | Technical lead | Supabase Auth and Storage endpoints | With `AUTH_PROVIDER=supabase`, sign-in cannot work | **Never** |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Technical lead | Browser-safe Supabase key | As above | **Never** |
| `SUPABASE_SERVICE_ROLE_KEY` | Technical lead | Private bucket access from the server | Objects fall back to local disk | **Never** |

`SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. It belongs to the
worker and to the storage adapter, and must never be reachable from a web
request path.

**Known gap:** re-verification for sensitive changes is implemented for the
local provider only. Under `AUTH_PROVIDER=supabase` it refuses with an
explanation rather than silently granting freshness, so those changes are
unavailable on a Supabase deployment until that path is built and tested
against the real service.

### Email

| Variable | Owner | Enables | Without it | Exercised |
| --- | --- | --- | --- | --- |
| `EMAIL_PROVIDER` | Technical lead | `smtp` for real delivery | Anything else uses the development sink, which records messages as `development_sink` — a state distinct from `sent` — and the interface says they were not delivered | Local only |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` | Technical lead | Delivery through the provider | Missing any one of them falls back to the sink **with the reason**, never to a silent success | Local only (an in-process SMTP server) |

Not represented by any variable, and not verifiable from this repository: SPF,
DKIM and DMARC records for the sending domain, and bounce and complaint
handling. A provider account that sends without them has mail that lands in
spam folders, and the product cannot tell.

`SMTP_ALLOW_SELF_SIGNED=true` disables certificate verification. Development
only; `pnpm preflight` reports it as a failure.

### Malware scanning

| Variable | Owner | Enables | Without it | Exercised |
| --- | --- | --- | --- | --- |
| `MALWARE_SCANNER` | Technical lead | `clamav` streams uploads to clamd over INSTREAM | Unset means every upload is recorded `skipped_not_configured` and stays quarantined, so no document can be shared. Nothing is ever reported as scanned | Local only (a mock daemon) |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` | Technical lead | Where the daemon is | Defaults to `127.0.0.1:3310` | Local only |

Leave `MALWARE_SCANNER` **empty** when there is no scanner. Any other value,
`none` included, is an unrecognised scanner, and the product records that as a
*failed* scan rather than as no scan. Both quarantine the file; only one of them
is true.

A scan that fails or times out is never treated as clean, and a quarantined
document can never be shared — enforced by the `documents_quarantine_not_shared`
check constraint as well as by the code.

### Document storage

| Variable | Owner | Enables | Without it | Exercised |
| --- | --- | --- | --- | --- |
| `SUPABASE_STORAGE_BUCKET` | Technical lead | The private bucket name | Defaults to `propertyos-private` | **Never** |
| `LOCAL_STORAGE_ROOT` | Technical lead | Filesystem objects for development | Defaults to `.storage` | Local only |

In both cases the permission check happens **before** any URL is minted. The
Supabase path has never run against a real project.

**Separate arrangement required:** Supabase database backups do not include
Storage object bytes. No object backup is configured. `scripts/restore-verify.sh`
writes a manifest of every object key a restored database expects, which is what
an object backup would have to contain.

### Application

| Variable | Owner | Enables | Without it | Exercised |
| --- | --- | --- | --- | --- |
| `APP_BASE_URL` | Technical lead | Invitation links, signed downloads, portal links | Links are built against the wrong origin. In production it must be `https` | Local only |
| `DEFAULT_COUNTRY`, `DEFAULT_CURRENCY`, `DEFAULT_TIME_ZONE` | Operator | ZA / ZAR / Africa-Johannesburg | Defaults apply | Local only |
| `WORKER_ID`, `WORKER_POLL_INTERVAL_MS`, `WORKER_MAX_ATTEMPTS` | Technical lead | Worker identity and pacing | Defaults apply | Local only |
| `APP_REVISION` | Build | Correlates a deploy with an incident | `/healthz` reports `unknown` | Local only |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Technical lead | A stable key for Server Action closure encryption across instances | Behind more than one instance, or across a restart, actions encrypted by one instance cannot be read by another and fail at the client | **Never** |

### Rent payment provider — deliberately absent

| Variable | Owner | Enables | Status |
| --- | --- | --- | --- |
| `RENT_PAYMENT_PROVIDER_ENABLED` | Founder + legal | Nothing yet | Must stay `false`. No provider is implemented, and none may be enabled before the merchant account owner, settlement destination and funds custody arrangement are confirmed in writing. See `docs/decisions/0004`. `pnpm preflight` fails if it is true |

Subscription billing for the SaaS itself is a separate concern from rent and
does not share this switch.

## Staging rehearsal

Production-intended adapters have **not** been exercised in a staging
environment, because no staging environment exists and every external account
needs its own authorisation. The procedure, for when those accounts exist:

1. Provision staging in isolation: its own database, its own Supabase project,
   its own SMTP credentials, its own bucket. Never point staging at production
   anything.
2. Set the variables above from the staging secret store. Set
   `NODE_ENV=production` so production code paths are the ones exercised.
3. `pnpm db:migrate`, then `pnpm preflight --probe --strict`. It must report no
   failures and no gaps before anything else is attempted.
4. Walk the paths a configuration error hides behind, and check the *recorded*
   state, not the screen: send a staff invitation and confirm the notification
   row reads `sent` with the provider's queue id; upload a document and confirm
   it leaves quarantine with a real scanner verdict; sign in through Supabase
   Auth, enrol a second factor and complete a sensitive change.
5. Rehearse recovery against staging data at a realistic size, per
   `docs/runbooks/recovery.md`, and record the measured numbers.
6. Record the result here, moving each row from "Local only" to "Real service"
   only for what was actually contacted.

Until step 6 has been done for a row, that row has not been verified, whatever
the interface shows.
