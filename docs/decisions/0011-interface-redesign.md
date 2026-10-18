# ADR 0011 — Operator console redesign

**Status:** accepted · **Date:** 2026-10-18

## Why

The console worked and read as a prototype. Everything was a rounded card of
equal weight, so a quiet day and a bad day looked identical; money was set in a
typewriter face; explanatory paragraphs sat above the figures they described and
pushed the operational content below the fold; the whole interface was tinted
with the brand lavender, which left nothing for the brand to emphasise.

None of that is a data problem, so none of it was fixed by changing data. What
changed is the shared layer — tokens, typography, primitives, shell — and then
the five screens an operator spends their day in.

## Decisions

**A neutral surface, purple reserved.** `--color-ink-*` is a neutral grey ramp;
the page is off-white, surfaces are white with a one-pixel neutral border.
Spike purple now means exactly three things: the primary action, the selected
navigation item, and a link. Both theme blocks carry the same tokens, enforced
by `tests/unit/theme.test.ts`.

**Two typefaces, locally served.** Manrope for page titles, section headings and
headline figures; Inter for everything else. Both are vendored woff2 subsets
loaded through `next/font/local`, so a build needs no network and a reader with
no webfont gets a metric-compatible fallback. The monospace face is now reserved
for references and technical identifiers — `.technical` — and money uses Inter
with tabular figures (`.tabular`). A rand amount is a number, not a machine
identifier, and setting it in a typewriter face made every statement look like a
log file.

**Cards for summaries, tables for records, lists for tasks, toolbars for
filters.** The attention queue became a list of rows: an item with nothing in it
collapses to one muted line rather than occupying a card to announce a zero.
Filters became a strip, not a titled card. Long explanations moved into
`<Disclosure>` — closed by default, still on the page, still in the exports.

**Tabs are links.** Reconciliation and the lease account are tabbed, and every
tab is a URL. The overview's tiles can therefore point at one queue, which they
do, and a cut-off travels with the lease tabs so moving between them never
re-dates a statement silently.

**Honest capability copy.** The reconciliation page offered bank statement
import in one card and said import "is not built" in another. The import,
preview, duplicate refusal and payer suggestions all exist; a bank feed does
not. One disclosure now describes the three separately — manual CSV import
(built), payer suggestions (built, suggestions only), live feed (not connected)
— and nothing else on the page describes the capability, so there is nowhere for
a second, staler description to contradict it.

## Two data-ordering corrections

Both were visible in the redesign and are corrections, not cosmetics.

**Same-day statement ordering.** `buildStatement` ordered by
`entry_date, entry_kind, reference`, and `allocation` sorts before `charge`, so
a payment appeared above the charge it settled and the running balance dipped
below zero before recovering. The order is now charges, then allocations, then
reference — the order the accounting happened in. Deterministic either way; this
one matches the model. The PDF and CSV are built from the same statement, so
they change with it; their layout does not.

**Natural unit ordering in the rent roll.** `order by p.name, u.code` put U10
between U1 and U2. It now sorts on the code's letters, then its first run of
digits as a number, then the code itself.

## What was deliberately not done

- **No invented history.** No sparklines, no month-on-month percentages: there
  is no correctly scoped time series behind them, and a trend drawn from one
  period of data is a lie with a gradient.
- **No statement "from" date.** The exports take a cut-off only. A screen that
  could be narrowed where the file could not would be a scope the export
  silently widened, so the period selector sets the cut-off alone.
- **The resident portal and the exported document layouts are untouched** beyond
  inheriting the shared tokens.
