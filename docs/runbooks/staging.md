# Running a staging demo you can open from anywhere

> **This is not set up.** The demo currently runs on your own machine —
> `pnpm host start`, then `http://localhost:3000`, which is what
> `docs/runbooks/local-demo.md` describes. Nothing in this file has been done,
> and the GitHub workflow it refers to has its automatic triggers commented out
> so it cannot fail on a secret that does not exist. Follow this page when you
> want the demo reachable from a phone or from someone else's browser; until
> then it is a plan, not a description.

A bookmarked URL that always shows the latest code, with demo data, reachable
from a phone. No terminal, no git, nothing to remember.

It is **not** production. Credentials live in this database rather than in
Supabase Auth, no email provider is configured, no malware scanner is running,
and every record is synthetic. `docs/deployment.md` is the production checklist
and this is not it.

| | |
| --- | --- |
| The app | Vercel, free hobby tier, redeploys on every push to `master` |
| The database | Supabase, free tier, does not expire |
| Migrations and the worker | GitHub Actions, in this repository |
| Your time, once | About fifteen minutes |
| Cost | Nothing, at this size |

Supabase pauses a free project after a week with no connections and resumes it
when something connects, so the first page load after a quiet week is slow. The
scheduled worker run every fifteen minutes keeps it awake in practice.

---

## 1. The database (about five minutes)

1. Create a project at [supabase.com](https://supabase.com). Any region near
   you; the free plan is enough. Save the database password it asks you to set.
2. Open **Project settings → Database → Connection string → URI** and copy two
   of them:
   - the **direct** connection (port `5432`) — migrations and the worker use it;
   - the **transaction pooler** (port `6543`) — the app uses it, because a
     serverless runtime opens and closes connections constantly and the pooler
     is what survives that.
3. Open the **SQL editor** and run this once. It creates the unprivileged role
   the application runs as — the one that cannot bypass row-level security.
   Replace the password with one you generate.

   ```sql
   create role propertyos_app_login login password 'CHANGE-ME-TO-SOMETHING-LONG';
   alter role propertyos_app_login nosuperuser nobypassrls nocreatedb nocreaterole;
   ```

   The grants that make it useful are applied by the migrations, so this is the
   whole of it. The application refuses to start if this role turns out to be a
   superuser or to hold `BYPASSRLS`, which is the point of creating it by hand.

## 2. The migrations and the demo data (about three minutes)

1. In this repository: **Settings → Secrets and variables → Actions → New
   repository secret**.
   - Name: `STAGING_DATABASE_URL`
   - Value: the **direct** (port 5432) connection string from step 1, with the
     database password in it.
2. Go to **Actions → Staging → Run workflow**, choose **reset-demo-data**, type
   `RESET` in the confirm box, and run it. It applies every migration, seeds the
   `[DEMO]` organisations and enrols the second factors for the demo accounts.

That workflow is also how you reset the demo later. It is meant to run by
itself in two other cases — when a push changes a migration, and every fifteen
minutes to drain the worker queue — and both triggers are commented out at the
top of `.github/workflows/staging.yml`. Uncomment them once this secret exists,
and not before: a scheduled run without it fails every fifteen minutes.

## 3. The app (about five minutes)

1. Import the repository at [vercel.com/new](https://vercel.com/new).
2. Set **Root Directory** to `apps/web`. Leave the framework as Next.js; the
   build and install commands are detected.
3. Add these environment variables, for all three environments:

   | Name | Value |
   | --- | --- |
   | `APP_DATABASE_URL` | the **pooler** (6543) string, with `propertyos_app_login` and its password |
   | `DATABASE_URL` | the same pooler string, with the Supabase postgres user — used by nothing in the request path, and required for startup checks |
   | `SESSION_SECRET` | 32+ random bytes. Generate: `openssl rand -base64 48` |
   | `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | another 32+ random bytes, the same value for every deployment |
   | `AUTH_PROVIDER` | `local` |
   | `EMAIL_PROVIDER` | `sink` |
   | `APP_BASE_URL` | your Vercel URL, e.g. `https://propertyos.vercel.app` |

   `APP_DATABASE_URL` is a security boundary: it is the role that row-level
   security is enforced against. There is deliberately no fallback to
   `DATABASE_URL`, because turning a misconfiguration into a silent loss of
   tenant isolation is worse than refusing to boot.

4. Deploy. Every push to `master` redeploys from then on.

## 4. Check it

Open `https://<your-app>/healthz`. It answers 200 with `tenantIsolation: ok`
when the app is talking to the database as the unprivileged role. If it reports
anything else, that is the thing to fix before signing in.

Then sign in at `/sign-in`:

| Account | Password |
| --- | --- |
| `admin@demo.invalid` | `DemoPassword123!` |
| `finance@demo.invalid` | `DemoPassword123!` |
| `thandiwe@demo.invalid` (resident portal) | `DemoPassword123!` |

Elevated roles need a second factor. The reset workflow enrols one for the
admin and finance accounts and prints the `otpauth://` URI in its log — open
the run, expand the reset step, and scan it into any authenticator app. The
resident account needs no code.

## Afterwards

- **A push deploys itself.** Vercel rebuilds on every push to `master`; a push
  that adds a migration also triggers the Staging workflow, which applies it.
- **Resetting the demo**: Actions → Staging → Run workflow →
  `reset-demo-data`, confirm with `RESET`.
- **Nothing is delivered.** Invoice messages are queued, attempted by the
  scheduled worker and recorded as undelivered with the sink adapter's reason.
  That is what the product does without an email provider, and every screen
  says so.
- **Uploads are quarantined.** No scanner is configured, so a file somebody
  uploads cannot be shared from the staging demo.

## If something does not work

| What you see | What it is |
| --- | --- |
| `/healthz` reports `tenantIsolation: failed` | `APP_DATABASE_URL` is pointing at the postgres superuser rather than `propertyos_app_login` |
| Sign-in says the password is wrong for every account | The demo data has not been seeded: run the reset workflow |
| An admin signs in and the console is nearly empty | Correct: elevated permissions are withheld without a second factor. Enrol one from the workflow log |
| A page errors about a missing column | A migration has not been applied: Actions → Staging → `migrate` |
| Everything is slow on the first load after a quiet week | Supabase resumed the paused project. The next load is normal |
