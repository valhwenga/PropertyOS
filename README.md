# Spike PropertyOS

Rental property management for South African landlords managing roughly 2–100
rentable units. Built to the *PropertyOS Product and Technology Blueprint v0.1*.

> **Status: pilot development build.** All five milestones are implemented, with
> 162 automated tests passing against a real PostgreSQL database. This is **not**
> production ready. See [`docs/pilot-readiness.md`](docs/pilot-readiness.md) for
> the blockers, [`docs/known-limitations.md`](docs/known-limitations.md) for what
> is missing, and [`docs/security-review.md`](docs/security-review.md) for the
> security self-assessment and its gaps.

## What works today

The complete rent workflow runs on real persisted data:

```
create organisation → add property and unit → add resident → activate lease
→ post charge → confirm EFT receipt → allocate receipt → accurate statement
```

The blueprint's worked example is an automated acceptance fixture:
opening arrears R1,000 + rent R8,000 + water R350 − allocated receipt R7,500
= **closing receivable R1,850.00**.

## Stack

| Layer | Choice |
| --- | --- |
| Web | Next.js 16 (App Router), React 19, TypeScript 5.9 |
| Runtime | Node.js 22 LTS |
| Styling | Tailwind CSS 4 with Spike design tokens |
| Database | PostgreSQL 16 (managed Supabase in production) |
| Access layer | Reviewed SQL migrations + `postgres.js` typed queries |
| Auth | Adapter: Supabase Auth (production) / local credentials (development) |
| Worker | Dedicated Node process, durable PostgreSQL jobs + transactional outbox |
| Tests | Vitest (unit, database/RLS, integration), Playwright (browser) |

## Repository layout

```
apps/web            Operator console, resident portal, Spike administration
apps/worker         Durable job runner and outbox publisher
packages/domain     Business commands, money, ledger, policies  (no React)
packages/db         Migrations, connection layer, RLS context
packages/ui         Accessible components and design tokens
packages/integrations  Email, storage and scanning adapters
tests               Unit, isolation, financial invariant and browser suites
docs                Architecture decisions, runbooks, limitations
```

Financial logic lives entirely in `packages/domain`. No React component posts a
journal.

## Getting started

### Quickest: one command

```bash
./scripts/preview.sh          # or: pnpm preview
```

It checks the toolchain, finds (or starts) PostgreSQL, creates the unprivileged
application role, writes a `.env.local` with a freshly generated
`SESSION_SECRET`, applies the migrations, seeds synthetic `[DEMO]` data, enrols
second factors for the demo accounts, starts the worker, and opens the app on
<http://localhost:3000> — printing the sign-in details and the current
authentication codes.

| | |
| --- | --- |
| `pnpm preview` | start it; reuses the database and data already there |
| `pnpm preview:reset` | rebuild the database from migrations and reseed |
| `pnpm preview:check` | browser checks that a running preview actually works |
| `./scripts/preview.sh --build` | run a production build instead of dev mode |
| `./scripts/preview.sh --docker` | run PostgreSQL in a throwaway container |
| `./scripts/preview.sh --no-worker` | skip the background worker |
| `./scripts/preview.sh --port=4000` | serve on another port |

It will not touch any database other than `propertyos_dev`, it refuses to run
with `NODE_ENV=production`, and it drops nothing unless you pass `--reset`.

**About the authentication codes.** Elevated roles are MFA-gated inside
`app.has_permission`, so an administrator signed in with only a password holds
*none* of their elevated permissions — the console renders but shows almost
nothing. That is deliberate, and it is also why a plain `pnpm db:seed` looks
broken. The preview enrols a TOTP factor for the demo accounts so those paths
can actually be exercised:

```bash
pnpm db:mfa enrol admin@demo.invalid   # prints the secret and an otpauth:// URI
pnpm db:mfa code  admin@demo.invalid   # the code valid right now
pnpm db:mfa list                       # which accounts have a factor
```

Sign-in still verifies the code normally, replay protection included — this is a
convenience, not a bypass. The command refuses to run when `NODE_ENV=production`
or when Supabase Auth owns enrolment.

Two consequences of that enforcement will catch you out locally, and both are
the controls working rather than faults: a code can be used **once**, so two
sign-ins as the same account inside one 30-second window will see the second
refused; and **eight** wrong passwords or codes for one address within 15
minutes locks that address out for the rest of the window, reporting only the
same generic message as a wrong password.

**What has actually been exercised.** The path verified end to end is a local
PostgreSQL with the app on your machine, in both dev and `--build` mode. The
container paths — `./scripts/preview.sh --docker`, which runs only PostgreSQL in
a container, and `docker-compose.yml`, which describes the whole stack and needs
`SESSION_SECRET` and `APP_DB_PASSWORD` set — have not been run end to end.
Treat them as a starting point.

### Doing it by hand

Useful when you want a different database, a remote one, or Supabase.

#### 1. Prerequisites

* Node.js 22 LTS, pnpm 10
* PostgreSQL 16 (local) or a Supabase project

#### 2. Database roles

PropertyOS uses **two** database connections and the distinction is a security
boundary:

| Connection | Role | Used for |
| --- | --- | --- |
| `DATABASE_URL` | owner | migrations and the worker only |
| `APP_DATABASE_URL` | `propertyos_app_login` | every web request |

The application role must be a member of `propertyos_app` and must be **neither
a superuser nor hold `BYPASSRLS`**. The app verifies this at startup and
refuses to serve traffic otherwise.

```sql
create role propertyos_app_login login password '<strong password>';
alter role propertyos_app_login nosuperuser nobypassrls nocreatedb nocreaterole;
-- after migrations have run:
grant propertyos_app to propertyos_app_login;
grant connect on database propertyos to propertyos_app_login;
```

#### 3. Configure and run

```bash
cp .env.example .env.local      # then fill in the values
pnpm install
pnpm db:migrate                 # applies reviewed SQL from an empty database
pnpm db:seed                    # synthetic [DEMO] data — development only
pnpm dev                        # http://localhost:3000
pnpm worker                     # in a second terminal
```

Seeded development accounts (password `DemoPassword123!`):

| Account | Role |
| --- | --- |
| `admin@demo.invalid` | Organisation administrator — needs a code |
| `finance@demo.invalid` | Finance approver — needs a code |
| `thandiwe@demo.invalid` | Resident (portal) |
| `other-admin@demo.invalid` | A **second** customer — sees none of the above |
| `support@demo.invalid` | Spike operator — needs an authorised support session |

### Tests

```bash
pnpm test           # unit + database/RLS + integration (needs PostgreSQL)
pnpm test:e2e       # Playwright browser suite (needs a running preview)
pnpm preview:check  # just the preview smoke checks
```

The test harness drops and rebuilds its database from empty on every run, so a
green suite also proves the migrations are reproducible.

The browser suite expects a preview with seeded demo data already running, and
passes against both dev mode and `--build`. On a machine that cannot download
browsers, point Playwright at one you already have:
`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium`.

### Backup and restore

```bash
./scripts/backup.sh                                  # writes a checksummed archive
./scripts/restore-verify.sh backups/<archive>.dump   # restores to a scratch DB and verifies
```

`restore-verify.sh` never touches the source database. It checks that every book
balances, that no allocation exceeds its receipt, that no cross-organisation
reference survived and that Row Level Security is still enabled — and reports
what it did **not** verify.

## Documentation

* [Pilot readiness](docs/pilot-readiness.md) — blockers before real data
* [Acceptance traceability](docs/acceptance.md) — every blueprint launch
  scenario mapped to the test that proves it
* [Architecture decisions](docs/decisions/) — isolation, accounting, money flow,
  durable jobs, operations visibility, the Spike platform boundary
* [Runbooks](docs/runbooks/) — billing, reconciliation, reports, uploads, recovery
* [Deployment](docs/deployment.md) — environment, roles, containers, rollback
* [Security model](docs/security.md) and
  [self-assessment](docs/security-review.md)
* [Known limitations](docs/known-limitations.md) — what is not done
