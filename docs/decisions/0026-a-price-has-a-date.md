# 0026 — A price has a date

**Status:** accepted · 2026-10-27

## The problem

`plans` has carried a price since the first migration and nothing ever wrote
to it. Launching a tier, raising R899, or widening an allowance meant a
migration and a deploy, which made the commercial side of the business the one
part of it an engineer had to perform. The console could put a customer on a
plan and could not say what a plan costs.

## Why not editable price columns

Because the billing run reads the plan's price **at the moment it runs**.
Invoicing March in April, after a rise on 1 April, would charge March at
April's price. Nobody would notice until a customer did, and by then the
invoice would have been sent.

So a price gets a date. `plan_prices` is what a plan has cost and will cost;
`plans` keeps what a plan *is* — name, currency, whether it can still be sold.
`app.plan_price_at(plan, date)` answers "what was it then", and the run asks
for the price in force on the **first day of the period it is billing**.

## What the shape buys

- **A rise is scheduled, not performed.** The same call sets today's price and
  next quarter's, because a price is a row with a date and "now" is just a
  date. A scheduled price is visibly different from one in force and can still
  be changed or dropped.
- **An invoiced period cannot be repriced.** Issued invoices carry their own
  figures and are never rewritten, so a price change across one would leave the
  invoice and the price list disagreeing for ever. The trigger refuses it and
  names the invoice.
- **"Why were they charged that?" is answerable from the console.** The whole
  history is on the screen with the reason and who set it, which is the support
  question before it is a billing one — so the page is readable by any
  operator and writable with `platform.billing.manage`.

## Three things the work found

**The price columns had to go, not stay.** A `monthly_price_minor` on `plans`
that no longer decides anything is a trap for the next reader. Dropping them
turned "did I find every reader?" into a question the migration answers:
`changePlan` and the provisioning page both failed immediately, and neither had
shown up in the first grep because it summarised per file.

**A customer vanished from a billing run.** Joining the price into the run with
an inner join drops any customer whose plan had no price in force for that
period — a plan created this month, billed for last. A customer silently
missing from a billing run is the worst outcome available here, so the join is
LEFT and the run names them in `skipped` with the reason, like every other
customer it passes over.

**A freshly seeded environment had a console nobody could use.** Migration 0072
backfilled a platform role onto every operator that existed when it ran, which
covers an upgraded database and not a new one: after a reset, the demo operator
had console access and no roles, and every screen told them their role did not
include it. The seed now grants `platform_admin` alongside the operator flag. A
browser test found it, which is the only way it could have been found — every
integration fixture builds its own operator with roles.

## What this does not do

It has no per-customer price: a customer who negotiates a discount still has to
be put on a plan that costs that. That is the next obvious step and is
deliberately not in this change, because a per-customer price interacts with
plan changes, proration and the invoice narrative, and none of those have been
thought through yet. Nor is there proration of any kind — a plan change takes
effect for the next period, as it did before.
