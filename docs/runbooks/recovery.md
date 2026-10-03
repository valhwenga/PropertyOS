# Runbook — backup and recovery

> **These are targets, not demonstrated capabilities.** No restore exercise has
> been performed for this build. Do not quote a recovery time to a customer
> until one has been completed and timed.

## What must be backed up

| Asset | Mechanism | Note |
| --- | --- | --- |
| Database | Supabase backups / PITR | Choose the tier from acceptable financial data loss and cost |
| Storage objects | **Separate arrangement required** | Supabase database backups do **not** include Storage object bytes |
| Schema migrations | Git | Reproducible from empty — proven on every test run |
| Environment configuration | Managed secret store | Never in Git |

Recovery credentials must be stored separately from routine developer access.

## Restore procedure

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
