# 0020 — Asking for an account

**Status:** accepted · 2026-10-21

## The problem

Every organisation in the product was typed in by a Spike operator at
`/platform/new`. A landlord who found PropertyOS had no way to say so, which
makes every customer an account somebody at Spike already knew about and makes
"how do people start using this" an unanswerable question.

## What we decided

A public form at `/request-access` that records an **enquiry**, and a queue at
`/platform/signups` where an operator approves it by provisioning the
organisation through the path that already exists.

It is deliberately not a sign-up, and the screens say so rather than implying
otherwise.

## Why not unattended sign-up

Creating an account without a person in the loop needs two things this build
does not have.

**No email provider.** Nothing can prove the address typed into the form
belongs to whoever typed it. `docs/known-limitations.md` has carried this since
the first milestone: notifications are written and never sent. An unverified
address is not a weak version of a verified one — it is a stranger's claim, and
the invitation that creates the first administrator would be sent to it.

**No payment provider.** An account costs nothing to open. Together with the
above, "create your account" means anybody can mint organisations at any
address, on any plan, as fast as they can post a form. The rate limit in
`app.request_platform_access` bounds that for a queue of rows a human reads; it
would not make it safe for a queue of live organisations.

So the decision is not "self-service is wrong" but "self-service without those
two is a hole with a form in front of it". When an email provider exists, the
honest next step is verifying the address before the request is queued, not
removing the human.

## How it is built

- `signup_requests` carries no `organisation_id` until it is approved, because
  until then there is no organisation. That makes it one of the few tables not
  keyed on membership: the policy is platform-operator or nobody.
- The application role holds **no INSERT grant** on it. The public form reaches
  the table only through `app.request_platform_access`, a security-definer
  function that validates, rate-limits per address hash and inserts — the same
  shape as the public rental-application path in migration 0029. A missing
  grant is a better guarantee than a policy somebody can widen later.
- A partial unique index allows one *open* request per email address, so a
  refreshed form does not become two accounts, and the function reports that
  as a sentence rather than an error.
- Approving calls `provisionCustomer` unchanged: same invitation, same clash
  rules, same audit entry, same operator second factor. Nothing about this
  feature is a second way to create an organisation.
- The operator still chooses the address, the plan and the registered legal
  name. Those three are what a stranger typing into a public form has no
  business deciding, and the address in particular appears in every URL the
  customer will ever use.
- Declining keeps the reason on the row and sends nothing, because there is
  nothing to send with. The console says that plainly instead of implying a
  message went out.

## What this does not do

It does not verify anything, it does not charge anything, and it does not tell
the person what was decided. All three wait on providers the build does not
have, and are recorded in `docs/known-limitations.md` rather than implied by a
screen.
