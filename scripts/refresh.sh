#!/usr/bin/env bash
#
# One command: the latest code, running, with fresh demo data.
#
# This exists because "pull, install, migrate, reseed, restart, and work out
# which of those you forgot" is five chances to end up looking at yesterday's
# build and concluding the product is broken. Every one of those steps has a
# failure that looks like nothing happening, so each one says what it did.
#
#   ./scripts/refresh.sh            latest code, database rebuilt, preview up
#   ./scripts/refresh.sh --keep     latest code, keep the data you have
#   ./scripts/refresh.sh --port=4000
#
set -euo pipefail
cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; RESET=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
die()  { printf '\n%serror:%s %s\n\n' "$RED" "$RESET" "$1" >&2; exit 1; }

RESET_DB=1
PASS_THROUGH=()
for arg in "$@"; do
  case "$arg" in
    --keep) RESET_DB=0 ;;
    *) PASS_THROUGH+=("$arg") ;;
  esac
done

# --------------------------------------------------------------- 1. the code
step 'Getting the latest code'

command -v git >/dev/null || die 'git is not installed.'
git rev-parse --git-dir >/dev/null 2>&1 || die "this is not a git clone, so there is nothing to pull.
    Clone it instead:
      git clone https://github.com/valhwenga/propertyos.git"

if [ -n "$(git status --porcelain)" ]; then
  printf '\n%s' "$(git status --short)"
  die 'you have local changes, so pulling could overwrite them.
    Keep them:     git stash
    Or drop them:  git checkout .
    Then run this again.'
fi

BEFORE="$(git rev-parse --short HEAD)"
BRANCH="$(git branch --show-current)"
git remote get-url origin >/dev/null 2>&1 \
  || die "this clone has no 'origin' remote, so git pull has nothing to fetch.
    Point it at the repository:
      git remote add origin https://github.com/valhwenga/propertyos.git"

git pull --ff-only origin "${BRANCH:-master}" >/dev/null 2>&1 \
  || die "could not fast-forward ${BRANCH:-master} from origin.
    Run 'git pull' on its own to see what git says about it."

AFTER="$(git rev-parse --short HEAD)"
if [ "$BEFORE" = "$AFTER" ]; then
  ok "already on the latest commit ($AFTER)"
else
  ok "updated $BEFORE → $AFTER"
  printf '%s' "$DIM"
  git --no-pager log --oneline "$BEFORE..$AFTER" | sed 's/^/      /'
  printf '%s' "$RESET"
fi

# ------------------------------------------------------- 2. the dependencies
step 'Installing dependencies'
command -v pnpm >/dev/null \
  || die 'pnpm is not installed. Run: corepack enable && corepack prepare pnpm@10.28.0 --activate'
pnpm install --silent
ok 'dependencies are current'

# ------------------------------------------------- 3. stop the old preview
# A preview left running from before the pull is the single most effective way
# to look at old code and believe it is new, so this stops it rather than
# letting the port check refuse later.
step 'Stopping anything already serving the preview'
PORT=3000
for arg in "${PASS_THROUGH[@]:-}"; do
  case "$arg" in --port=*) PORT="${arg#*=}" ;; esac
done

if command -v lsof >/dev/null; then
  HOLDERS="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$HOLDERS" ]; then
    # shellcheck disable=SC2086
    kill $HOLDERS 2>/dev/null || true
    sleep 1
    ok "stopped the preview on port $PORT"
  else
    ok "nothing was listening on port $PORT"
  fi
fi

# Next keeps a build cache that survives a kill, and a cache written by a
# server that was stopped mid-compile serves 404s for pages that exist.
if [ "$BEFORE" != "$AFTER" ]; then
  rm -rf apps/web/.next
  ok 'cleared the build cache, because the code changed'
fi

# ------------------------------------------------------------ 4. and run it
step 'Starting the preview'
if [ "$RESET_DB" -eq 1 ]; then
  printf '    %srebuilding propertyos_dev from the migrations and reseeding%s\n' "$DIM" "$RESET"
  exec ./scripts/preview.sh --reset "${PASS_THROUGH[@]:-}"
fi
printf '    %skeeping the data already in propertyos_dev%s\n' "$DIM" "$RESET"
exec ./scripts/preview.sh "${PASS_THROUGH[@]:-}"
