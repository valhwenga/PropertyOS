# 0029 — A way back in

**Status:** accepted · 2026-10-27

## The problem

There was no account recovery of any kind, and no password reset either.

Multi-factor authentication is enforced in the database, recovery codes are
shown once at enrolment, and ADR 0045's reasoning for having no administrator
reset and no Spike reset is sound: anybody who can clear a colleague's second
factor can take over their account.

The consequence was not sound. A landlord who forgot a password, or lost the
phone with their authenticator and could not find the codes they were shown
once, was locked out of their own tenancy records permanently. The only remedy
in the product was somebody running `pnpm db:mfa` against the database. That is
not a product, and on a pilot with real landlords it comes up in the first
month.

## What we decided

A recovery **request**: the person asks, somebody else decides, and approval
issues a link rather than granting anything.

### The customer's own administrator decides it

The person who can tell whether this is really Thandiwe is the colleague who
works with her, not Spike. `membership.manage` already names that person — it
is the permission that invites and removes staff — and approving a recovery is
the same kind of act, so it needed no new role.

Their approval is effective at once. There is nothing for a waiting period to
protect against that is not already true of everything else that permission
lets them do.

### Spike decides it only when nobody else can, and the rule is enforced

A solo landlord has no colleague, and for them Spike must be able to act or the
product is unusable. So the request reaches Spike **only** when the person has
no active colleague holding `membership.manage` — not filtered out of a list,
not shown and refused: the policies make the row unreadable to an operator
while somebody else could decide it.

That rule is stated three times on purpose: in the policy, in the domain
function, and in the query the console uses. Once would have been enough if
every read went through the caller's own context, and they do not — several
platform pages read with `readPrivilegedAs`, which lifts row-level filtering.
This page is deliberately not one of them.

### Spike's route waits, and the account holder can stop it

An approval by Spike takes effect after a delay — a platform setting, 24 hours
by default — and issues a second token that cancels it. The notice goes to the
address on the account, and the cancel page needs no password and no second
factor, because somebody who has lost both is exactly who needs it.

That is what makes the route defensible: an operator who has been talked into a
recovery by a convincing caller cannot do it quietly, and the real owner gets
told before it works.

**The honest limit, which the screen states rather than hides:** that
protection is only as good as the notice reaching them by some channel the
operator does not control, and there is no mail provider configured. Today the
notice is queued and undelivered, so the operator has to tell them another way
— and the approval box therefore asks what they checked and against what, at
length, rather than a ticket number.

### Approval is not delivery

The link is shown once to whoever approved it, to be handed over the way staff
invitations already are in this product, by a channel they chose. Nothing
emails it. That is not a workaround for the missing mail provider: a link sent
to the address of an account that may itself be compromised is worth less than
one read out over a phone call to a number already on file, and the screens say
so.

### The link does only what was lost

A forgotten password does not clear a second factor — resetting the password
leaves the authenticator in the way, which is the entire point of having one —
and a lost authenticator does not reset a password. Clearing a factor takes its
recovery codes with it, and signing in with no verified factor lands at `aal1`,
so every MFA-gated permission is refused until the person enrols again. That is
the right end state rather than a gap.

### Asking tells the asker nothing

The form answers with one sentence whether the address has an account, has one
with a request already open, or has none at all. A form that says "no account
with that address" is an account enumeration tool with a helpful tone, and this
one is reachable by anybody with the address of the site. The request is
recorded either way — so the rate limit and the evidence exist — and the
unknown-address case is visible only to Spike, who declines it.

### One administrator can take over another's login

That is what this route is, said plainly. An `org_admin` can ask on a
colleague's behalf by typing their address into the public form, approve it,
and receive the link. Nothing prevents it.

Two things make it tolerable. `org_admin` is the top customer role, so the
taker gains no permission they did not already hold — what they gain is the
ability to act **as** that person, which is a repudiation problem rather than
an escalation one. And it is not quiet: the approval is audited with the
approver's name and their stated verification, and a notice goes to the account
holder saying somebody was given a way into their account. The control is
visibility, not prevention, and the ADR says so rather than implying otherwise.

What is prevented is the one case where it would be escalation: the
organisation route **refuses** to recover a Spike operator's account. No
operator is a member of any customer organisation today, and that guard costs
one query, so it exists before somebody discovers otherwise.

## What the work found

**The test harness is kinder than production, again.** The assertion that Spike
cannot see a request while a colleague exists passed against a policy that did
not say so, because the suite's own operator helper runs through
`withPrivilegedActor` and lifts row-level filtering. The same trap as ADR 0028's
storage keys, two commits apart. The rule is now also in the query, and the test
asserts it under the operator's own context as well as under a lifted one.

**A table that broke an invariant for a good reason.** `recovery_requests`
carries no `organisation_id`, so the schema invariant that every
customer-owned table carries one failed — correctly. It belongs to a person
rather than an organisation: they may be a member of several, of none, or of
none anybody can name, because the form records a request for an address with
no account and must answer identically either way. It went on the documented
exclusion list with that reasoning, which is what the list is for.

**A refusal that read as nonsense to the person it was for.** `notFound()`
builds `"<thing> not found."`, which is right for naming a resource and wrong
as a sentence carrier — so the invalid-link page told a locked-out person
"...the recovery may have not found." Caught by reading the page a test had
captured rather than by the test, which only asserted the heading.

**A subpath alias that silently resolved to nothing.** `@propertyos/db/client`
could not be imported from the test suite: the bare `@propertyos/db` alias
matches as a prefix and swallowed it. The config already had a comment warning
about exactly this, written when `@propertyos/domain/dates` hit it.

## What this does not do

**It works only with the local auth provider.** Resetting a password writes
`auth.users.password_hash` and clearing a factor deletes from
`auth_mfa_factors`, which is where the local provider keeps credentials. With
`AUTH_PROVIDER=supabase`, Supabase owns them and a link would change nothing —
so the action refuses outright rather than reporting a reset that did not
happen, and the operator console says the same. Supporting Supabase means the
auth adapter gaining a credential-reset method and a live project to verify it
against.

It also does not notify anybody automatically, does not expire an open request
(it sits until somebody decides it), and offers residents nothing: their access
comes through a lease rather than a password, so the page tells them to ask
their landlord for a new portal link.
