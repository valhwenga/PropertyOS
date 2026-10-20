#!/usr/bin/env bash
#
# Keep Spike PropertyOS running on this machine, like a small service.
#
# The preview script is something you run and watch: it holds the terminal, and
# closing that window takes the app with it. This runs the same stack in the
# background, with one place to look when it misbehaves — so the answer to "can
# I see the system" is a bookmark rather than a command you have to remember.
#
#   pnpm host start            build it and run it, detached
#   pnpm host start --dev      skip the production build, start in seconds
#   pnpm host start --reset    rebuild the demo data while starting
#   pnpm host status           up or not, on what commit, is there anything newer
#   pnpm host stop             stop the web app and the worker
#   pnpm host update           pull, reinstall, rebuild, restart
#   pnpm host logs             follow the log
#
# What it writes lives in .local/ (git-ignored): the log, the pid, and the port
# it was last started on, so every other command knows where to look.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

STATE_DIR=.local
LOG="$STATE_DIR/host.log"
PID_FILE="$STATE_DIR/host.pid"
PORT_FILE="$STATE_DIR/host.port"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; OFF=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; OFF=''
fi
say()  { printf '%s\n' "$1"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '    %s!%s %s\n' "$RED" "$OFF" "$1"; }
die()  { printf '\n%serror:%s %s\n\n' "$RED" "$OFF" "$1" >&2; exit 1; }

mkdir -p "$STATE_DIR"
PORT="$(cat "$PORT_FILE" 2>/dev/null || echo 3000)"

# Whether anything ANSWERS on the port, which is the only question that matters.
# A pid file goes stale, and in some containers a listener is invisible to lsof;
# a connection that completes cannot be wrong.
answers() {
  node -e "
    const net = require('net');
    const s = net.connect($1, '127.0.0.1');
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('error', () => process.exit(1));
    setTimeout(() => { s.destroy(); process.exit(1); }, 1500);
  " >/dev/null 2>&1
}

# Flags this script understands, separated from the ones that belong to the
# preview. Passing an unknown option to the preview makes it exit 2.
PREVIEW_ARGS=()
MODE_ARG=--build
parse_start_args() {
  for arg in "$@"; do
    case "$arg" in
      --dev)    MODE_ARG='' ;;
      --build)  MODE_ARG=--build ;;
      --port=*) PORT="${arg#*=}"; PREVIEW_ARGS+=("$arg") ;;
      *)        PREVIEW_ARGS+=("$arg") ;;
    esac
  done
}

start() {
  parse_start_args "$@"

  if answers "$PORT"; then
    say "${BOLD}Already running${OFF} on http://localhost:$PORT"
    say "${DIM}  pnpm host update   put the latest code on it"
    say "  pnpm host stop     stop it${OFF}"
    return 0
  fi

  printf '%s' "$PORT" > "$PORT_FILE"
  : > "$LOG"
  if [ -n "$MODE_ARG" ]; then
    say "${BOLD}Starting PropertyOS${OFF} ${DIM}(production build — a few minutes the first time)${OFF}"
  else
    say "${BOLD}Starting PropertyOS${OFF} ${DIM}(development mode)${OFF}"
  fi
  say "${DIM}  following along: pnpm host logs${OFF}"

  # Detached, with its own output file, so closing this window leaves it alone.
  #
  # `set -m` is what makes it stoppable. Without it a background job shares this
  # shell's process group, so the recorded pid is the preview script and its
  # children — the web server and the worker — outlive a kill of it. With job
  # control on, the job becomes its own process group leader, which means the
  # pid below is also a group id and one signal reaches all three. That matters
  # because Next rewrites its process title to `next-server (v16.3.8)`: there is
  # no path left in its command line to match on afterwards.
  set -m
  nohup ./scripts/preview.sh ${MODE_ARG:+$MODE_ARG} ${PREVIEW_ARGS[@]+"${PREVIEW_ARGS[@]}"} >> "$LOG" 2>&1 &
  printf '%s' "$!" > "$PID_FILE"
  set +m

  local waited=0
  while [ "$waited" -lt 900 ]; do
    if answers "$PORT"; then
      ok "listening on http://localhost:$PORT"
      accounts
      return 0
    fi
    if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      warn 'it stopped before it started listening. The last of the log:'
      tail -20 "$LOG" | sed 's/^/      /'
      die "the rest is in $LOG"
    fi
    sleep 2
    waited=$((waited + 2))
  done
  die "it did not start listening within fifteen minutes. See $LOG."
}

accounts() {
  say ''
  say "  ${BOLD}http://localhost:$PORT${OFF}"
  say ''
  say "  ${DIM}Sign in with — the password for every demo account is DemoPassword123!${OFF}"
  say '    admin@demo.invalid        the landlord console, asks for a code'
  say '    thandiwe@demo.invalid     the resident portal, no code'
  say ''
  say "  ${DIM}When it asks for the code:${OFF}"
  say '    pnpm db:mfa code admin@demo.invalid'
  say ''
}

# Whatever holds the port, when the pid file is no help: a copy started before
# this script existed, or one whose group has already been reaped.
port_holder() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null && return 0
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -lptnH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}

stop() {
  local signalled=0 pid=''
  [ -f "$PID_FILE" ] && pid="$(cat "$PID_FILE")"

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # The negative pid is the process group: the preview script, the web server
    # and the worker in one signal.
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    signalled=1
  fi

  local holders
  holders="$(port_holder "$PORT" || true)"
  if [ -n "$holders" ]; then
    # shellcheck disable=SC2086
    kill -TERM $holders 2>/dev/null || true
    signalled=1
  fi

  local waited=0
  while [ "$waited" -lt 10 ] && answers "$PORT"; do
    sleep 1
    waited=$((waited + 1))
  done

  if answers "$PORT"; then
    [ -n "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null || true
    holders="$(port_holder "$PORT" || true)"
    # shellcheck disable=SC2086
    [ -n "$holders" ] && kill -KILL $holders 2>/dev/null || true
    sleep 1
  fi

  rm -f "$PID_FILE"
  if answers "$PORT"; then
    warn "something is still answering on port $PORT and would not stop."
    warn "Find it with: lsof -ti tcp:$PORT   (or: ss -lptn 'sport = :$PORT')"
    return 1
  fi
  if [ "$signalled" -eq 1 ]; then
    ok 'stopped'
  else
    ok 'nothing was running'
  fi
}

status() {
  local commit subject
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  subject="$(git log -1 --pretty=%s 2>/dev/null || echo '')"
  if answers "$PORT"; then
    say "${GREEN}●${OFF} ${BOLD}Running${OFF} on http://localhost:$PORT"
  else
    say "${RED}○${OFF} ${BOLD}Not running${OFF} ${DIM}— pnpm host start${OFF}"
  fi
  say "${DIM}  commit   $commit  $subject"
  local behind
  if behind="$(git rev-list --count 'HEAD..@{upstream}' 2>/dev/null)" && [ "${behind:-0}" -gt 0 ]; then
    say "  updates  $behind newer commit(s) on origin — pnpm host update"
  else
    say '  updates  nothing newer, as far as the last fetch knows'
  fi
  say "  log      $LOG${OFF}"
}

case "${1:-status}" in
  start)  shift; start "$@" ;;
  stop)   stop ;;
  status) status ;;
  logs)
    [ -f "$LOG" ] || die "there is no log yet. Start it with: pnpm host start"
    tail -f "$LOG" ;;
  update)
    shift
    stop
    # The refresh does the pull, the install and the stale-build cache; told not
    # to start anything, because starting it detached is this script's job.
    ./scripts/refresh.sh --no-start "$@" \
      || die 'the update stopped before restarting. Nothing is running now; fix what it reported and run pnpm host start.'
    start "$@" ;;
  -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "unknown command '$1'. Use: start, stop, status, update, logs." ;;
esac
