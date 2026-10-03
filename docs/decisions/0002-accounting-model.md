# ADR 0002 — Accounting model

**Status:** accepted · **Date:** 2026-10-03

## Decision

A balanced double-entry subledger, with the invariants enforced in PostgreSQL.

### Money representation

Integer **minor units** (`bigint`) throughout. Rates use `numeric` with explicit
scale. `postgres.js` returns `bigint` columns as strings and we deliberately do
not override that, so an amount is never silently coerced to a float.
`tests/db/bigint-fidelity.test.ts` pins this.

### Balance

A `DEFERRABLE INITIALLY DEFERRED` constraint trigger checks, per currency, that
debits equal credits before the posting transaction may commit. No client-supplied
total is trusted, and the check cannot be skipped by writing to the tables
directly.

### Standard entries

| Event | Debit | Credit |
| --- | --- | --- |
| Post rent charge | Resident receivable | Rental income |
| Confirm receipt | Landlord bank control | Unapplied resident receipts |
| Confirm unidentified receipt | Landlord bank control | **Suspense** |
| Allocate receipt | Unapplied receipts | Resident receivable |
| Receive deposit | Deposit bank control | Resident deposit liability |
| Approved deposit refund | Resident deposit liability | Deposit bank control |
| Paid maintenance invoice | Property maintenance expense | Landlord bank control |

Deposits are a liability and never touch rental income. They do not reduce the
rent receivable until an approved, lawful transfer is posted.

### Immutability and correction

Posted journals, journal lines and posted charge lines are immutable: `BEFORE
UPDATE/DELETE` triggers reject the operation, and `UPDATE`/`DELETE` privileges
are revoked from the application roles. Corrections are **linked** credit notes,
adjustments or reversals. The original is always readable.

### Concurrency

The over-allocation trigger takes `SELECT ... FOR UPDATE` on the **receipt
first**, then the charge line. Every allocation path acquires locks in that
order, so concurrent allocations serialise and no deadlock cycle is possible
between the two resources. Verified by a test that races two transactions for
the same R1,000: exactly one wins, the other is refused.

### Period locks

`journals` carries a `BEFORE INSERT` trigger rejecting any posting into a locked
period. Reopening requires the `period.lock` permission and writes an audit event.

## Status

An accountant has **not** yet confirmed the chart of accounts, tax treatment or
entity boundaries. This is a proposed operational model, as the blueprint
describes it, and must be validated before the first live cycle.
