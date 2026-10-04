# Deployment

## Before a production deploy

A deploy is not ready because the build passes. The following must all be true:

- [ ] `pnpm test` green, including the isolation and financial invariant suites
- [ ] `APP_DATABASE_URL` points at a role that is **not** a superuser and does
      **not** hold `BYPASSRLS` (the app refuses to start otherwise, but verify it
      before the deploy rather than discovering it in the logs)
- [ ] `SESSION_SECRET` is at least 32 bytes, generated per environment, stored in
      a managed secret store — never in the repository
- [ ] `AUTH_PROVIDER=supabase` with `NEXT_PUBLIC_SUPABASE_URL` and
      `NEXT_PUBLIC_SUPABASE_ANON_KEY` set
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is **absent from the web runtime**. It bypasses
      Row Level Security and must never be reachable from a request path
- [ ] Database backups configured, **and a restore exercised** (see below)
- [ ] Storage object backup arranged separately — Supabase database backups do
      not include Storage bytes
- [ ] Migrations applied: `pnpm db:migrate`
- [ ] `/healthz` returns 200 with `tenantIsolation: ok`

## Environment variables

See [`.env.example`](../.env.example). The two that are security boundaries:

| Variable | Role | Must never |
| --- | --- | --- |
| `DATABASE_URL` | Owner. Migrations and worker only. | Serve a web request |
| `APP_DATABASE_URL` | `propertyos_app_login`, RLS enforced | Be a superuser or hold BYPASSRLS |

There is deliberately **no fallback** from the second to the first. A missing
`APP_DATABASE_URL` is a startup failure, because turning a misconfiguration into
a silent loss of tenant isolation is worse than refusing to boot.

## Database roles

```sql
create role propertyos_app_login login password '<from your secret store>';
alter role propertyos_app_login nosuperuser nobypassrls nocreatedb nocreaterole;
-- After migrations have run, as the owner:
grant propertyos_app to propertyos_app_login;
grant connect on database propertyos to propertyos_app_login;
```

Verify:

```sql
select rolname, rolsuper, rolbypassrls from pg_roles
where rolname = 'propertyos_app_login';
-- rolsuper and rolbypassrls must both be false
```

## Containers

```bash
docker build --target runtime --build-arg APP_REVISION="$(git rev-parse --short HEAD)" -t propertyos-web .
docker build --target worker -t propertyos-worker .
```

Both images run as a non-root user. The web image carries a `HEALTHCHECK`
against `/healthz`.

For a local full stack including PostgreSQL:

```bash
export SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
export APP_DB_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
docker compose up --build
```

`docker-compose.yml` is for local use only. It has no TLS termination, no backup
schedule and no secret management.

## Running the worker

The worker is a separate process sharing the domain packages. It must run
somewhere that restarts it on exit. Several instances are safe: jobs are claimed
with `FOR UPDATE SKIP LOCKED`, so no job is ever handed to two workers, and a
worker that dies mid-job has it reclaimed after a 15-minute lease.

## Observability

* `/healthz` — liveness and readiness, including the tenant-isolation self-check.
  Returns 503 when the application role could bypass RLS.
* Structured JSON logs on stdout/stderr, with a correlation id on every error.
  Field names matching password, secret, token, identity number, account number
  or storage key are redacted before writing.
* Every user-facing error carries a correlation id that appears in the logs, so
  support can trace a report without asking for a screenshot of the data.

**Not yet wired up:** error aggregation, uptime monitoring, performance tracing,
alerting. The logs are produced; nothing consumes them. See
[`known-limitations.md`](known-limitations.md).

## Rollback

Application rollback is a redeploy of the previous image. **Migrations are not
automatically reversible**: they are forward-only, and the runner refuses to
re-apply a file whose checksum changed. To roll back a schema change, write a new
migration that reverses it, and ensure the previous application image tolerates
the current schema before rolling back the app.

Posted financial history is immutable by design, so a rollback never "undoes"
money. Corrections are posted as linked reversals.
