#!/usr/bin/env bash
#
# One command to get Spike PropertyOS running locally with demo data.
#
#   ./scripts/preview.sh              start the preview (reuses existing data)
#   ./scripts/preview.sh --reset      rebuild the database from migrations and reseed
#   ./scripts/preview.sh --docker     run PostgreSQL in Docker instead of natively
#   ./scripts/preview.sh --no-worker  skip the background worker
#   ./scripts/preview.sh --build      run the production build rather than dev mode
#
# Everything this creates is development-only and clearly labelled: the database
# is `propertyos_dev`, demo organisations are prefixed [DEMO], and demo accounts
# use the reserved .invalid TLD so no address can ever receive real mail.
#
# What it will NOT do: it only ever touches the `propertyos_dev` database, it
# refuses to start if NODE_ENV is already production, and it drops nothing
# unless you pass --reset.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

RESET=false
USE_DOCKER=false
RUN_WORKER=true
MODE=dev
PORT="${PREVIEW_PORT:-3000}"

for arg in "$@"; do
  case "$arg" in
    --reset)     RESET=true ;;
    --docker)    USE_DOCKER=true ;;
    --no-worker) RUN_WORKER=false ;;
    --build)     MODE=build ;;
    --port=*)    PORT="${arg#*=}" ;;
    -h|--help)   sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Colour only when a terminal is actually attached, so a redirected log stays
# readable.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET_C=$'\033[0m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
else
  BOLD=''; DIM=''; RESET_C=''; GREEN=''; YELLOW=''; RED=''
fi
step() { printf '%s==>%s %s\n' "$BOLD" "$RESET_C" "$1"; }
ok()   { printf '    %s%s%s\n' "$GREEN" "$1" "$RESET_C"; }
warn() { printf '    %s%s%s\n' "$YELLOW" "$1" "$RESET_C"; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET_C" "$1" >&2; exit 1; }

DB_NAME=propertyos_dev
APP_ROLE=propertyos_app_login
APP_PASSWORD="${APP_DB_PASSWORD:-devpassword}"
COMPOSE_PROJECT=propertyos-preview

# The password is interpolated into CREATE ROLE and into the connection string,
# so refuse the characters that would break either rather than trying to escape
# them. A local development password has no reason to contain them.
case "$APP_PASSWORD" in
  *\'*|*\"*|*@*|*\\*|*' '*|*'/'*|*':'*)
    printf 'error: APP_DB_PASSWORD must not contain quotes, spaces, backslashes, @, : or /\n' >&2
    exit 1 ;;
esac

# --------------------------------------------------------------- 1. toolchain
step 'Checking the toolchain'

command -v node >/dev/null || die 'Node.js is not installed. Install Node 22 LTS: https://nodejs.org'
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "Node 22 or newer is required (found $(node -v)). The repo pins >=22.11 <23."
fi
command -v pnpm >/dev/null || die 'pnpm is not installed. Run: corepack enable && corepack prepare pnpm@10.28.0 --activate'
ok "node $(node -v), pnpm $(pnpm --version)"

if [ "${NODE_ENV:-}" = 'production' ]; then
  die 'NODE_ENV=production. The preview seeds synthetic demo data and must never run against production.'
fi

# ------------------------------------------------------------- 2. postgresql
# Either talk to a PostgreSQL already listening on localhost, or bring one up in
# Docker. Nothing else is started automatically: a database the script did not
# create is a database it should not be reconfiguring.
step 'Looking for PostgreSQL'

PGHOST=127.0.0.1
PGPORT="${PGPORT:-5432}"

pg_listening() {
  if command -v pg_isready >/dev/null; then
    pg_isready -h "$PGHOST" -p "$PGPORT" -q && return 0 || return 1
  fi
  node -e "
    const net = require('node:net');
    const s = net.connect($PGPORT, '$PGHOST');
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 2000);
  " >/dev/null 2>&1
}

docker_usable() { command -v docker >/dev/null && docker info >/dev/null 2>&1; }
# pg_ctl is frequently NOT on PATH even when a server is installed (Debian puts
# it under /usr/lib/postgresql/<version>/bin, Homebrew under its own prefix), so
# look in the usual places too before concluding nothing is installed.
PG_CTL=
pg_installed() {
  if command -v pg_ctl >/dev/null; then PG_CTL=$(command -v pg_ctl); return 0; fi
  for candidate in \
    /usr/lib/postgresql/*/bin/pg_ctl \
    /opt/homebrew/opt/postgresql@*/bin/pg_ctl \
    /usr/local/opt/postgresql@*/bin/pg_ctl \
    /Applications/Postgres.app/Contents/Versions/*/bin/pg_ctl
  do
    if [ -x "$candidate" ]; then PG_CTL="$candidate"; return 0; fi
  done
  command -v postgres >/dev/null
}

USING_DOCKER=false
if [ "$USE_DOCKER" = false ] && pg_listening; then
  ok "using the PostgreSQL already listening on $PGHOST:$PGPORT"
  SUPERUSER_URL="${PREVIEW_SUPERUSER_URL:-postgresql://postgres@$PGHOST:$PGPORT/postgres}"
elif [ "$USE_DOCKER" = false ] && pg_installed; then
  # A cluster is installed but stopped. Starting a Docker one instead would be a
  # surprise — it would come up empty next to the data they already have — so
  # ask rather than choose for them.
  die "PostgreSQL is installed but nothing is listening on $PGHOST:$PGPORT.
    Start it, then run this again:
      - macOS (Homebrew):  brew services start postgresql@16
      - Linux (systemd):   sudo systemctl start postgresql
      - Postgres.app:      open it and click Start
      - a cluster of your own:  ${PG_CTL:-pg_ctl} -D <data directory> start
    Running on another port? Re-run with PGPORT=<port>.
    Would rather not use it? Re-run with --docker for a throwaway container."
elif docker_usable; then
  step 'Starting PostgreSQL 16 in Docker'
  USING_DOCKER=true
  PGPORT=5432
  if ! docker ps --format '{{.Names}}' | grep -qx "$COMPOSE_PROJECT-db"; then
    docker run -d \
      --name "$COMPOSE_PROJECT-db" \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB=postgres \
      -p "$PGPORT:5432" \
      -v "$COMPOSE_PROJECT-data:/var/lib/postgresql/data" \
      postgres:16-alpine >/dev/null \
      || docker start "$COMPOSE_PROJECT-db" >/dev/null \
      || die 'could not start the PostgreSQL container'
  else
    ok 'container already running'
  fi
  printf '    waiting for the database'
  READY=false
  for _ in $(seq 1 60); do
    if docker exec "$COMPOSE_PROJECT-db" pg_isready -q 2>/dev/null; then READY=true; break; fi
    printf '.'; sleep 1
  done
  printf '\n'
  [ "$READY" = true ] || die "the PostgreSQL container did not become ready.
    Check it with: docker logs $COMPOSE_PROJECT-db"
  SUPERUSER_URL="postgresql://postgres:postgres@$PGHOST:$PGPORT/postgres"
  ok 'container ready'
elif [ "$USE_DOCKER" = true ]; then
  die "--docker was requested but Docker is not usable here.
    Check that Docker Desktop (or the daemon) is running: docker info"
else
  die "No PostgreSQL on $PGHOST:$PGPORT, and no usable Docker.
    Install one of them, then run this again:
      - macOS:  brew install postgresql@16 && brew services start postgresql@16
      - Linux:  sudo apt install postgresql-16 && sudo systemctl start postgresql
      - Docker: install Docker Desktop, then re-run with --docker"
fi

psql_super() { psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -qtAX "$@"; }
if ! command -v psql >/dev/null; then
  if [ "$USING_DOCKER" = true ]; then
    psql_super() { docker exec -i "$COMPOSE_PROJECT-db" psql "$SUPERUSER_URL" -v ON_ERROR_STOP=1 -qtAX "$@"; }
  else
    die 'psql is not on PATH. Install the PostgreSQL client tools, or use --docker.'
  fi
fi

psql_super -c 'select 1' >/dev/null 2>&1 \
  || die "cannot connect as a superuser using $SUPERUSER_URL
    Set PREVIEW_SUPERUSER_URL to a working superuser connection string and retry."

# ----------------------------------------------------- 3. role and database
step 'Preparing the development database'

# The application connects as a role with neither SUPERUSER nor BYPASSRLS. That
# is the whole point of the row-level security work: a preview that connected as
# the owner would silently prove nothing.
psql_super <<SQL >/dev/null
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname = '$APP_ROLE') then
    create role $APP_ROLE login password '$APP_PASSWORD' nosuperuser nobypassrls nocreatedb nocreaterole;
  else
    alter role $APP_ROLE login password '$APP_PASSWORD' nosuperuser nobypassrls;
  end if;
end
\$\$;
SQL
ok "application role $APP_ROLE is present and unprivileged"

DB_EXISTS=$(psql_super -c "select 1 from pg_database where datname = '$DB_NAME'")
if [ "$RESET" = true ] && [ -n "$DB_EXISTS" ]; then
  warn "--reset: dropping and recreating $DB_NAME (all local data in it is lost)"
  psql_super -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$DB_NAME' and pid <> pg_backend_pid()" >/dev/null
  psql_super -c "drop database $DB_NAME" >/dev/null
  DB_EXISTS=
fi
if [ -z "$DB_EXISTS" ]; then
  psql_super -c "create database $DB_NAME" >/dev/null
  ok "created $DB_NAME"
else
  ok "reusing the existing $DB_NAME"
fi

SUPER_DB_URL="${SUPERUSER_URL%/*}/$DB_NAME"

# Queries against the development database itself. Separate from psql_super,
# which is connected to the maintenance database and used to create roles and
# databases.
psql_db() {
  if [ "$USING_DOCKER" = true ] && ! command -v psql >/dev/null; then
    docker exec -i "$COMPOSE_PROJECT-db" psql "$SUPER_DB_URL" -v ON_ERROR_STOP=1 -qtAX "$@"
  else
    psql "$SUPER_DB_URL" -v ON_ERROR_STOP=1 -qtAX "$@"
  fi
}

# ---------------------------------------------------------------- 4. env file
step 'Checking configuration'

ENV_FILE="$ROOT/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
  cat > "$ENV_FILE" <<ENV
# Written by scripts/preview.sh for LOCAL PREVIEW ONLY. Not committed, and not
# suitable for any deployed environment: the secret below was generated on this
# machine and the database password is a well-known development default.
NODE_ENV=development

# Owner connection: migrations and the seed only.
DATABASE_URL=$SUPER_DB_URL
# Application connection: no SUPERUSER, no BYPASSRLS, row-level security applies.
APP_DATABASE_URL=postgresql://$APP_ROLE:$APP_PASSWORD@$PGHOST:$PGPORT/$DB_NAME

AUTH_PROVIDER=local
SESSION_SECRET=$SECRET

# Mail goes to a labelled development sink. Nothing is delivered, and nothing is
# reported as delivered.
EMAIL_PROVIDER=sink
EMAIL_FROM=no-reply@propertyos.invalid

# Uploads are stored on this machine and served through signed, authorised URLs.
LOCAL_STORAGE_ROOT=$HOME/.propertyos-storage

# No malware scanner is configured, so uploads stay quarantined and are not
# claimed to be scanned. Set MALWARE_SCANNER=clamav with a reachable daemon to
# turn real scanning on.
MALWARE_SCANNER=none

APP_BASE_URL=http://localhost:$PORT
DEFAULT_COUNTRY=ZA
DEFAULT_CURRENCY=ZAR
DEFAULT_TIME_ZONE=Africa/Johannesburg

# Rent payment providers stay off until merchant ownership and settlement are
# confirmed. See docs/known-limitations.md.
RENT_PAYMENT_PROVIDER_ENABLED=false
ENV
  ok 'wrote .env.local with a freshly generated SESSION_SECRET'
else
  ok 'reusing the existing .env.local'
  EXISTING_SECRET=$(sed -n 's/^SESSION_SECRET=//p' "$ENV_FILE" | head -1)
  if [ "${#EXISTING_SECRET}" -lt 32 ]; then
    die "SESSION_SECRET in .env.local is ${#EXISTING_SECRET} characters; at least 32 are required.
    Signed session cookies and signed document URLs both derive from it. Either
    set a longer value, or delete .env.local and let this script generate one."
  fi
fi

# Next.js reads env from its own directory, so the web app points at the single
# root file rather than a second copy that can drift out of step with it.
if [ ! -e "$ROOT/apps/web/.env.local" ]; then
  ln -s ../../.env.local "$ROOT/apps/web/.env.local" 2>/dev/null \
    || cp "$ENV_FILE" "$ROOT/apps/web/.env.local"
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
# Superuser connection details can differ from the committed default (Docker
# sets a password), so the migration URL follows whatever actually worked.
DATABASE_URL="$SUPER_DB_URL"
export DATABASE_URL
export APP_DATABASE_URL="postgresql://$APP_ROLE:$APP_PASSWORD@$PGHOST:$PGPORT/$DB_NAME"
export APP_BASE_URL="http://localhost:$PORT"

# ------------------------------------------------------------ 5. dependencies
if [ ! -d "$ROOT/node_modules" ]; then
  step 'Installing dependencies'
  pnpm install --frozen-lockfile
  ok 'dependencies installed'
fi

# -------------------------------------------------------------- 6. migrations
step 'Applying migrations'
pnpm --filter @propertyos/db migrate
# Privileges are granted to the group role by the migrations; the login role
# needs to be a member of it to inherit them.
psql_db -c "set client_min_messages = warning; grant propertyos_app to $APP_ROLE" >/dev/null
ok 'schema up to date'

# -------------------------------------------------------------- 7. demo data
# Ask whether the table exists before counting rows in it, so a genuine error
# here surfaces instead of being read as "nothing seeded yet" — which would send
# the seed in on top of existing records.
if [ -z "$(psql_db -c "select to_regclass('public.organisations')")" ]; then
  die 'the organisations table is missing after migrations; this should not happen'
fi
SEEDED=$(psql_db -c "select count(*) from organisations where slug like 'demo-%'")
if [ "${SEEDED:-0}" = '0' ]; then
  step 'Seeding synthetic demo data'
  pnpm --filter @propertyos/db seed
else
  step 'Demo data'
  ok "already present ($SEEDED demo organisations) — pass --reset to rebuild"
fi

# --------------------------------------------------------- 8. second factors
# Elevated roles are MFA-gated in app.has_permission, so without a verified
# factor the administrator signs in and can see almost nothing. Enrol one up
# front and print the codes, otherwise the preview looks broken rather than
# strict. Sign-in still verifies the code properly, replay protection included.
step 'Enrolling second factors for the demo accounts'
MFA_LINES=()
for account in admin@demo.invalid finance@demo.invalid support@demo.invalid other-admin@demo.invalid; do
  if pnpm --filter @propertyos/db exec tsx src/cli/mfa.ts enrol "$account" >/dev/null 2>&1; then :; fi
  CODE=$(pnpm --filter @propertyos/db exec tsx src/cli/mfa.ts code "$account" 2>/dev/null | tail -1 || true)
  MFA_LINES+=("$account ${CODE:-<run pnpm db:mfa code $account>}")
done
ok 'enrolled (codes are printed below and rotate every 30 seconds)'

# ------------------------------------------------------------------ 9. worker
WORKER_PID=
cleanup() {
  if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
    kill "$WORKER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$RUN_WORKER" = true ]; then
  step 'Starting the background worker'
  mkdir -p "$ROOT/.preview"
  pnpm --filter @propertyos/worker start > "$ROOT/.preview/worker.log" 2>&1 &
  WORKER_PID=$!
  sleep 2
  if kill -0 "$WORKER_PID" 2>/dev/null; then
    ok "running (pid $WORKER_PID, log .preview/worker.log)"
  else
    WORKER_PID=
    warn 'the worker exited immediately — see .preview/worker.log. The interface still works;'
    warn 'scheduled billing, outbox email and document scanning will not run.'
  fi
fi

# ----------------------------------------------------------------- 10. banner
cat <<BANNER

${BOLD}Spike PropertyOS — local preview${RESET_C}

  ${BOLD}http://localhost:$PORT${RESET_C}

  ${DIM}Sign in with (password for all: DemoPassword123!)${RESET_C}

  Landlord operator   admin@demo.invalid        full access, needs a code
  Finance preparer    finance@demo.invalid      raises charges and receipts
  Resident portal     thandiwe@demo.invalid     statements, evidence upload
  Second landlord     other-admin@demo.invalid  proves isolation: sees none of the above
  Spike support       support@demo.invalid      needs an authorised, time-limited session

  ${DIM}Current second-factor codes (valid ~30s; \`pnpm db:mfa code <email>\` for a fresh one)${RESET_C}

$(for line in "${MFA_LINES[@]}"; do printf '  %s\n' "$line"; done)

  ${DIM}Worth looking at${RESET_C}

  /app                                    portfolio overview
  /app/<org>/leases                       the blueprint's R1,850 acceptance fixture
  /portal                                 the resident's own view
  /healthz                                database and tenant-isolation checks

  ${DIM}This is development data. Organisations are prefixed [DEMO], addresses use${RESET_C}
  ${DIM}the .invalid TLD, no mail is delivered, no malware scanner is configured and${RESET_C}
  ${DIM}rent payment providers are off. See docs/known-limitations.md.${RESET_C}

  ${DIM}Ctrl-C stops both the web app and the worker.${RESET_C}

BANNER

# --------------------------------------------------------------- 11. web app
if [ "$MODE" = build ]; then
  # `next build` must run with NODE_ENV=production; with anything else React
  # resolves its development build and prerendering the error page fails. The
  # seed and the MFA helper already ran above under NODE_ENV=development, so
  # their refuse-in-production guards stayed in force.
  #
  # One consequence worth knowing: session cookies are marked Secure when
  # NODE_ENV=production. Browsers treat http://localhost as a secure context, so
  # sign-in still works here, but it is why this is not the default mode.
  export NODE_ENV=production
  step 'Building for production'
  pnpm build
  step "Starting the production server on port $PORT"
  pnpm --filter @propertyos/web exec next start -p "$PORT"
else
  step "Starting the development server on port $PORT"
  pnpm --filter @propertyos/web exec next dev -p "$PORT"
fi
