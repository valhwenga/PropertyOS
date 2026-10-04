#!/usr/bin/env bash
# Spike PropertyOS — restore into an isolated database and VERIFY it.
#
# A backup nobody has restored is a hope, not a recovery plan. This script
# restores into a scratch database and then checks the things that actually
# matter: that every book balances, that statements reproduce, and that
# relationships survived.
#
# It NEVER touches the source database.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (used only to derive the server)}"
ARCHIVE="${1:?usage: restore-verify.sh <archive.dump>}"
SCRATCH_DB="${SCRATCH_DB:-propertyos_restore_check}"

if [[ -f "${ARCHIVE}.sha256" ]]; then
  echo "Verifying archive checksum..."
  sha256sum --check "${ARCHIVE}.sha256"
fi

ADMIN_URL="${DATABASE_URL%/*}/postgres"
SCRATCH_URL="${DATABASE_URL%/*}/${SCRATCH_DB}"

echo "Recreating isolated database ${SCRATCH_DB}..."
psql -q "$ADMIN_URL" -c "drop database if exists ${SCRATCH_DB} with (force)"
psql -q "$ADMIN_URL" -c "create database ${SCRATCH_DB}"

START=$(date +%s)
echo "Restoring..."
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$SCRATCH_URL" "$ARCHIVE"
RESTORE_SECONDS=$(( $(date +%s) - START ))

echo
echo "=== Verification ==="

fail=0
check() {
  local label="$1" query="$2" expected="$3"
  local actual
  actual=$(psql -tA "$SCRATCH_URL" -c "$query")
  if [[ "$actual" == "$expected" ]]; then
    printf 'PASS  %-46s %s\n' "$label" "$actual"
  else
    printf 'FAIL  %-46s got %s, expected %s\n' "$label" "$actual" "$expected"
    fail=1
  fi
}

report() {
  local label="$1" query="$2"
  printf '      %-46s %s\n' "$label" "$(psql -tA "$SCRATCH_URL" -c "$query")"
}

# The single most important question after a restore: does the money still add up?
check "every financial book balances" \
  "select count(*) from (select book_id, currency_code from trial_balance group by book_id, currency_code having sum(net_minor) <> 0) t" \
  "0"

check "no journal is unbalanced" \
  "select count(*) from (select journal_id from journal_lines group by journal_id having sum(signed_minor) <> 0) j" \
  "0"

check "no allocation exceeds its receipt" \
  "select count(*) from (select pa.receipt_id, sum(pa.amount_minor) a, max(r.amount_minor) t from payment_allocations pa join receipts r on r.id = pa.receipt_id where pa.reversed_at is null group by pa.receipt_id having sum(pa.amount_minor) > max(r.amount_minor)) x" \
  "0"

check "no posted charge is missing its journal" \
  "select count(*) from charge_documents where status <> 'draft' and journal_id is null" \
  "0"

check "no confirmed receipt is missing its journal" \
  "select count(*) from receipts where status = 'confirmed' and journal_id is null" \
  "0"

check "no lease references a foreign organisation unit" \
  "select count(*) from leases l join units u on u.id = l.unit_id where u.organisation_id <> l.organisation_id" \
  "0"

check "no overlapping reserving leases survived" \
  "select count(*) from leases a join leases b on a.unit_id = b.unit_id and a.id < b.id where a.reserved_period && b.reserved_period" \
  "0"

check "row level security is still enabled on leases" \
  "select relrowsecurity::text from pg_class where relname = 'leases'" \
  "true"

check "row level security is still enabled on journals" \
  "select relrowsecurity::text from pg_class where relname = 'journals'" \
  "true"

report "organisations restored" "select count(*) from organisations"
report "leases restored" "select count(*) from leases"
report "journal lines restored" "select count(*) from journal_lines"
report "documents referenced (objects restored separately)" "select count(*) from documents where deleted_at is null"
report "jobs left mid-flight (review before resuming worker)" "select count(*) from jobs where status = 'running'"
report "unpublished outbox events" "select count(*) from outbox_events where published_at is null"

echo
echo "Restore took ${RESTORE_SECONDS}s."
echo
echo "NOT verified by this script, and required before declaring recovery complete:"
echo "  * Storage objects restored and reachable for the documents counted above."
echo "  * A sampled lease statement reproduces its expected closing balance."
echo "  * Sign-in works for a known account."
echo "Record the MEASURED recovery point and time. Those numbers, not the targets,"
echo "are what may be communicated to a customer."

exit "$fail"
