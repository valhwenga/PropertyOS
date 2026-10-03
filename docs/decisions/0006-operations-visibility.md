# ADR 0006 — Comment and document visibility

**Status:** accepted · **Date:** 2026-10-03

## Context

A maintenance ticket carries three different conversations at once: notes the
operator team keeps to itself, replies the resident must see, and instructions
the contractor needs. Leaking the first into the second is a privacy incident
("tenant is behind on rent, get a fixed quote") and is easy to cause with a
forgotten `WHERE` clause.

## Decision

**Audience is an access rule, not a display hint.**

`maintenance_comments.audience` and `maintenance_attachments.audience` are
enforced by Row Level Security: the resident policy selects
`audience = 'resident_visible'` only. A query that forgot to filter still cannot
return an internal note to a resident, because the row is not visible to that
connection at all.

The same principle governs documents. `documents.visibility` decides who can
read the row, and a check constraint
(`documents_quarantine_not_shared`) makes "shared" and "quarantined" a
contradiction the database refuses to store.

Write side is symmetrical: a resident may only ever author a
`resident_visible` comment, enforced both in the domain command and by the
policy's `WITH CHECK`.

### Consequences

* The operator UI labels every comment with its audience, and restates the
  audience directly above the compose box, because the cost of getting it wrong
  is borne by the resident.
* Residents are not organisation members, so each resident action that writes a
  child row (a ticket transition event, an inspection response, a download
  grant) needed its own narrow policy — migration 0011. These were added
  because tests failed, not because the gap was spotted in review.
* A resident disputing an inspection must not be able to write to `inspections`
  at all. The status is instead **re-derived** from the acknowledgement rows by
  `app.sync_inspection_response_status`, which takes no caller-supplied status:
  the worst a caller can do is recompute a value from data they were already
  permitted to write (migration 0012).

## Versioning instead of editing

Inspection templates are versioned, and an inspection records the template
version it was performed against, so changing a checklist can never retroactively
alter what an inspector actually checked. A finalised inspection is never edited:
`reviseInspection` creates a successor with a stated reason and marks the
original `superseded`, leaving it readable for a later dispute.

## Spending authority is separate from operational authority

`maintenance.quote.approve` is deliberately not granted to `property_manager`.
Triaging a ticket does not authorise committing the owner's money. A completed
work order records its expense exactly once — the unique index on
(organisation, vendor, invoice reference) rejects a second recording of the same
supplier invoice, so a receipt attached to both a ticket and an expense is not
counted twice — and an invoice above the approved ceiling is held as a **draft**
for someone with approval authority rather than being posted silently.
