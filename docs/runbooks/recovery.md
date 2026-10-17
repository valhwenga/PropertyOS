# Runbook — backup and recovery

## Measured results

A restore exercise **has** been performed for this build, on 17 October 2026,
against the development database, using `scripts/backup.sh` and
`scripts/restore-verify.sh`, and carried through to a running application.

| Measure | Result |
| --- | --- |
| Backup size | 672 KB (2 organisations, 1 lease, 16 journal lines, 29 audit events) |
| Archive checksum verified | yes |
| Restore into an isolated database | **1 second** (3.5 seconds including all verification) |
| Automated checks | **18 of 18 passed** |
| Financial books balancing, journals balanced, allocations within their receipt | all |
| Every lease statement reproduced from the ledger stream | matched the balance view for every lease |
| Separation of duties preserved | no deposit movement or payout request decided by its requester |
| Row Level Security | enabled on **every** table carrying an organisation id, each with policies |
| Application privileges | `app.assert_table_privileges()` passes on the restored database |
| Storage objects | manifest written; **every expected object present** (1 of 1, local object store) |
| Application against the restored database | starts; `/healthz` reports `tenantIsolation: ok` |
| Sign-in and figures on the restored database | `pnpm preview:check` — 4 of 4 passed, including the second factor, the resident's closing balance and isolation between two landlords |

**These numbers describe a small development dataset on a local machine.** They
demonstrate that the procedure works and that the verification catches what it
claims to; they are **not** a production recovery time. Re-run the exercise
against a production-sized dataset on production-class infrastructure before
quoting any figure to a customer.

### What the rehearsal found

Three defects, two of which a restore would have turned into an outage:

1. **The archive carried no privileges.** `backup.sh` dumped with
   `--no-privileges`, so a restored database came up clean and then answered
   `permission denied for table leases` to the application role. The dump now
   keeps its grants, the restore replays them, and the target cluster must carry
   the `propertyos_app` and `propertyos_worker` roles first —
   `restore-verify.sh` creates them, and `docs/deployment.md` has them for a
   real restore.
2. **The privilege guard had drifted.** `app.assert_table_privileges()` (0017)
   was meant to run at the end of every migration that adds a table, and
   nothing made that happen. `auth_mfa_recovery_codes` had been un-granted and
   un-exempted since 0045 — correct behaviour, with no record of why. Migration
   0049 records the exemption, and `tests/db/schema-invariants.test.ts` now
   asserts the guard on every test run, so it holds whether or not a migration
   remembers.
3. **The verification script hid its own failures.** Under `set -e`, a check
   whose query errored took the whole script down at that line, so every check
   after it went unreported — the failure mode this script exists to prevent,
   in the script itself. A failing check now reports `FAIL` and the run
   continues, and a report whose query errors is a failure rather than a blank.

Both negative paths were confirmed deliberately: a removed storage object fails
the object check and exits non-zero, and an injected broken query reports `FAIL`
while the remaining checks still run. The verification is not vacuous.

Still not demonstrated: recovery at production scale or on production-class
infrastructure, and object storage recovery from a real object backup (there is
no object backup configured; the manifest says what one would have to contain).

> The targets below remain targets. An ordinary daily backup cannot deliver a
> one-hour recovery point, whatever the table says.

## What must be backed up

| Asset | Mechanism | Note |
| --- | --- | --- |
| Database | Supabase backups / PITR | Choose the tier from acceptable financial data loss and cost |
| Storage objects | **Separate arrangement required** | Supabase database backups do **not** include Storage object bytes |
| Schema migrations | Git | Reproducible from empty — proven on every test run |
| Environment configuration | Managed secret store | Never in Git |

Recovery credentials must be stored separately from routine developer access.

## Automated procedure

```bash
export DATABASE_URL=...            # the SOURCE database
./scripts/backup.sh                # writes to ./backups with a checksum
./scripts/restore-verify.sh ./backups/propertyos-<stamp>.dump
```

`restore-verify.sh` restores into a scratch database — it never touches the
source — and then checks the things that actually matter: that every book
balances, that no allocation exceeds its receipt, that no cross-organisation
reference survived, and that Row Level Security is still enabled. It exits
non-zero if any check fails.

It deliberately reports what it has **not** verified, so a green run is not
mistaken for a complete recovery.

Finish the rehearsal by pointing the application at the restored database and
walking a real path through it, which is the part no SQL check can answer:

```bash
export APP_DATABASE_URL=".../propertyos_restore_check"
export DATABASE_URL=".../propertyos_restore_check"
pnpm dev                                   # or the built image
curl -s localhost:3000/healthz             # tenantIsolation must read ok
pnpm preview:check                         # sign-in, a real figure, isolation
```

`preview:check` expects the demo accounts, so against a customer's restored data
substitute a sign-in you have been given for the purpose. The point is the same:
somebody signs in and reads a figure they can check.

## Manual restore procedure

1. Provision an **isolated** environment. Never restore over production to test.
2. Restore the database to the chosen point in time.
3. Restore Storage objects for the matching window.
4. Apply any migrations newer than the snapshot: `pnpm db:migrate`.
5. **Verify before reconnecting anything:**
   * `select sum(net_minor) from trial_balance group by book_id, currency_code`
     — every book must net to zero.
   * Sampled lease statements reproduce their expected closing balances.
   * Documents referenced by restored rows actually resolve in Storage.
   * Sign-in works for a known account.
6. **Prevent duplicate work after restart.** Jobs restored in `running` state are
   reclaimed automatically after their lease expires. Before resuming the worker,
   review `jobs` where `status = 'dead'` and `outbox_events` where
   `published_at is null`. Handlers are idempotent, but a human should confirm
   that no billing run is mid-flight.
7. Record the measured recovery point and recovery time. Those numbers, not the
   targets, are what may be communicated.

## Incident response

Security compromises in South Africa are reported to the Information Regulator
through its eServices portal, and to affected data subjects. The Regulator
distinguishes an operator notifying the responsible party from the responsible
party's own notifications. **Do not apply a generic foreign 72-hour rule.**
Preserve evidence, record the incident with a correlation id, and follow the
contact list in the incident register.
