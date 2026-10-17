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

# The archive carries grants to the application roles, so those roles must exist
# here before pg_restore replays them. They are cluster-level and carry no
# password and no login right: this creates the grant targets, not a way in.
echo "Ensuring the application roles exist..."
psql -q "$ADMIN_URL" <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'propertyos_app') then
    create role propertyos_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'propertyos_worker') then
    create role propertyos_worker nologin;
  end if;
end
$$;
SQL

echo "Recreating isolated database ${SCRATCH_DB}..."
psql -q "$ADMIN_URL" -c "drop database if exists ${SCRATCH_DB} with (force)"
psql -q "$ADMIN_URL" -c "create database ${SCRATCH_DB}"

START=$(date +%s)
echo "Restoring..."
# Privileges are restored deliberately: without them the application role cannot
# read a single table, and the check below says so.
pg_restore --no-owner --exit-on-error --dbname="$SCRATCH_URL" "$ARCHIVE"
RESTORE_SECONDS=$(( $(date +%s) - START ))

echo
echo "=== Verification ==="

fail=0
check() {
  local label="$1" query="$2" expected="$3"
  local actual
  # A query that errors must FAIL this check and let the rest run. Without the
  # fallback, errexit takes the whole script down at the first failing check and
  # every check after it goes unreported — which is how a verification script
  # ends up hiding most of what it was asked to verify.
  actual=$(psql -tA "$SCRATCH_URL" -c "$query" 2>&1 | tail -1) || actual='<query failed>'

  if [[ "$actual" == "$expected" ]]; then
    printf 'PASS  %-46s %s\n' "$label" "$actual"
  else
    printf 'FAIL  %-46s got %s, expected %s\n' "$label" "$actual" "$expected"
    fail=1
  fi
}

# A report that quietly fails looks like an empty answer, which is the one
# thing a verification script must never do. A query that errors is a failure.
report() {
  local label="$1" query="$2" value
  if ! value=$(psql -tA --set=ON_ERROR_STOP=1 "$SCRATCH_URL" -c "$query" 2>&1); then
    printf 'FAIL  %-46s query failed: %s\n' "$label" "$(echo "$value" | head -1)"
    fail=1
    return
  fi
  printf '      %-46s %s\n' "$label" "$value"
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

# Row Level Security, as coverage rather than as two examples. Every table that
# carries an organisation id is customer data, so every one of them must still
# enforce it after a restore; and a table whose policies did not come back would
# deny everything, which is safe but is still a failed restore.
check "every table carrying an organisation id enforces RLS" \
  "select count(*) from information_schema.columns c join pg_class p on p.relname = c.table_name and p.relnamespace = 'public'::regnamespace where c.table_schema = 'public' and c.column_name = 'organisation_id' and p.relkind = 'r' and not p.relrowsecurity" \
  "0"

check "no table enforces RLS with its policies missing" \
  "select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)" \
  "0"

# The gap this script used to name and leave to a human: a statement is the
# closing balance a resident is shown, and it is derived from the ledger stream
# rather than from the balance view. Comparing the two reproduces every lease's
# statement, not a sample of them, and disagrees loudly if either side was
# restored incompletely.
check "every lease statement reproduces its balance" \
  "select count(*) from lease_balances lb join lateral (select coalesce(sum(e.debit_minor - e.credit_minor), 0) as derived from lease_ledger_entries e where e.lease_id = lb.lease_id) t on true where t.derived <> lb.receivable_minor" \
  "0"

check "no deposit account holds less than nothing" \
  "select count(*) from (select da.id from deposit_accounts da join deposit_events de on de.deposit_account_id = da.id group by da.id having sum(de.amount_minor) < 0) x" \
  "0"

# Separation of duties is recorded in the rows themselves, so a restore can be
# asked whether it survived. If it did not, the history is no longer evidence.
check "no deposit movement was approved by the person who asked for it" \
  "select count(*) from deposit_events where approved_by is not null and approved_by = requested_by" \
  "0"

check "no payout request was decided by its requester" \
  "select count(*) from deposit_payout_requests where decided_by is not null and decided_by = requested_by" \
  "0"

check "no posted expense is missing its journal" \
  "select count(*) from expenses where status in ('posted', 'paid') and journal_id is null" \
  "0"

# Quarantine is a check constraint, but a constraint that was restored without
# its data intact proves nothing. This asks the data.
check "no quarantined document is shared" \
  "select count(*) from documents where quarantined and visibility <> 'internal'" \
  "0"

check "no portal link reaches another organisation's lease" \
  "select count(*) from portal_links pl join leases l on l.id = pl.lease_id where l.organisation_id <> pl.organisation_id" \
  "0"

# A restore that loses the grants restores cleanly and is then unusable: the
# application role gets "permission denied" on its first query. This is the same
# assertion every migration ends with, asked of the restored database.
check "the application role can reach every table it must" \
  "select 'ok' from (select app.assert_table_privileges()) t" \
  "ok"

check "no work order belongs to another organisation's ticket" \
  "select count(*) from work_orders w join maintenance_tickets t on t.id = w.ticket_id where t.organisation_id <> w.organisation_id" \
  "0"

report "organisations restored" "select count(*) from organisations"
report "leases restored" "select count(*) from leases"
report "journal lines restored" "select count(*) from journal_lines"
report "documents referenced (objects restored separately)" "select count(*) from documents where deleted_at is null"
report "jobs left mid-flight (review before resuming worker)" "select count(*) from jobs where status = 'running'"
report "unpublished outbox events" "select count(*) from outbox_events where published_at is null"
report "audit events restored" "select count(*) from audit_events"
report "deposit liability held" "select coalesce(sum(amount_minor), 0) from deposit_events"
report "portal links still active" "select count(*) from portal_links where status = 'active' and revoked_at is null"

# Object storage is a separate backup, so the archive cannot answer for it. What
# it can do is name the keys a restored database expects, so whoever restores
# the objects knows what has to be there — and so that a missing object is found
# here rather than by a resident clicking a download link.
MANIFEST="${ARCHIVE%.dump}.objects.txt"
psql -tA -F $'\t' "$SCRATCH_URL" -c \
  "select storage_bucket, storage_key from documents where deleted_at is null order by 1, 2" \
  > "$MANIFEST"
EXPECTED=$(wc -l < "$MANIFEST")
printf '      %-46s %s\n' "storage keys the restored database expects" "${EXPECTED} (listed in ${MANIFEST})"

# Where objects live on a filesystem we can reach, the manifest is checkable
# rather than advisory, so check it: a restored row whose bytes are gone is a
# download link that will fail in front of a resident.
if [[ -n "${LOCAL_STORAGE_ROOT:-}" && -d "${LOCAL_STORAGE_ROOT}" ]]; then
  missing=0
  while IFS=$'\t' read -r _bucket key; do
    [[ -n "$key" ]] || continue
    [[ -f "${LOCAL_STORAGE_ROOT}/${key}" ]] || { missing=$((missing + 1)); echo "      MISSING OBJECT ${key}"; }
  done < "$MANIFEST"
  if (( missing == 0 )); then
    printf 'PASS  %-46s %s\n' "every expected storage object is present" "${EXPECTED}"
  else
    printf 'FAIL  %-46s %s\n' "storage objects missing" "${missing} of ${EXPECTED}"
    fail=1
  fi
else
  printf '      %-46s %s\n' "storage objects" "not checked (no local object store reachable)"
fi

echo
echo "Restore took ${RESTORE_SECONDS}s."
echo
echo "NOT verified by this script, and required before declaring recovery complete:"
if [[ -z "${LOCAL_STORAGE_ROOT:-}" || ! -d "${LOCAL_STORAGE_ROOT}" ]]; then
  echo "  * Storage objects restored and reachable for every key in the manifest above."
fi
echo "  * Sign-in works for a known account."
echo "  * The application starts against the restored database and /healthz reports"
echo "    tenantIsolation: ok."
echo "Record the MEASURED recovery point and time. Those numbers, not the targets,"
echo "are what may be communicated to a customer."

exit "$fail"
