# Runbook — backup and recovery

## Measured results

A restore exercise **has** been performed for this build, against the
development database, using `scripts/backup.sh` and `scripts/restore-verify.sh`:

| Measure | Result |
| --- | --- |
| Backup size | 448 KB (2 organisations, 1 lease, 12 journal lines) |
| Archive checksum verified | yes |
| Restore time into an isolated database | **1 second** |
| Financial books balancing after restore | all |
| Unbalanced journals after restore | 0 |
| Allocations exceeding their receipt | 0 |
| Posted charges missing a journal | 0 |
| Cross-organisation references | 0 |
| Overlapping reserving leases | 0 |
| Row Level Security still enabled | yes, verified on `leases` and `journals` |

**These numbers describe a small development dataset on a local machine.** They
demonstrate that the procedure works and that the verification catches what it
claims to; they are **not** a production recovery time. Re-run the exercise
against a production-sized dataset on production-class infrastructure before
quoting any figure to a customer.

Still not demonstrated: Storage object recovery (no object backup is configured),
and a full application-level recovery including sign-in and statement
reproduction.

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
