# Spike PropertyOS

Rental property management for South African landlords managing roughly 2–100
rentable units. Built to the *PropertyOS Product and Technology Blueprint v0.1*.

> **Status: pilot development build.** Milestones 1 and 2 are implemented and
> tested; Milestones 3–5 are partially implemented. This is **not** production
> ready — see [`docs/known-limitations.md`](docs/known-limitations.md) for the
> complete, honest list of what is missing and what remains unconfigured.

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

### 1. Prerequisites

* Node.js 22 LTS, pnpm 10
* PostgreSQL 16 (local) or a Supabase project

### 2. Database roles

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

### 3. Configure and run

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
| `admin@demo.invalid` | Organisation administrator |
| `finance@demo.invalid` | Finance approver |
| `thandiwe@demo.invalid` | Resident (portal) |
| `other-admin@demo.invalid` | A **second** customer — sees none of the above |
| `support@demo.invalid` | Spike operator — needs an authorised support session |

### 4. Tests

```bash
pnpm test          # unit + database/RLS + integration (needs PostgreSQL)
pnpm test:e2e      # Playwright browser suite
```

The test harness drops and rebuilds its database from empty on every run, so a
green suite also proves the migrations are reproducible.

## Documentation

* [Architecture decisions](docs/decisions/) — isolation, accounting, money flow
* [Runbooks](docs/runbooks/) — billing, reconciliation, recovery, incidents
* [Known limitations](docs/known-limitations.md) — what is not done
* [Security model](docs/security.md)
