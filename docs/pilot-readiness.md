# Pilot readiness assessment

**Status as at 2026-10-04.** This is an assessment, not a sign-off. Items marked
**BLOCKER** must be closed before a real resident's data enters the system.

## Summary

The financial core, tenant isolation and permission model are implemented,
tested against a real database, and I would defend them. The gaps are at the
edges where the product meets external services — email, file scanning, hosted
authentication — and in the things only humans can do: legal review, accounting
sign-off, and an independent security assessment.

**PropertyOS is not production ready.** It is, in my assessment, ready for a
controlled pilot on synthetic or anonymised data once the blockers below are
closed.

## Blockers

| # | Blocker | Why it blocks | Owner |
| --- | --- | --- | --- |
| 1 | **Supabase Auth not verified against a live project** | The sign-in and MFA adapters are implemented and the enforcement is fully tested, but no code path has run against a real Supabase project. Password policy, breach detection and account recovery are Supabase's, and none has been exercised. | Technical lead |
| 2 | **No malware scanning** | Uploads are quarantined and cannot be shared, which is safe but means document sharing is effectively unusable in production. | Technical lead |
| 3 | **No email delivery** | Residents cannot receive invitations or statements. The system is honest about this (`development_sink`, never `sent`), but the product does not function without it. | Technical lead |
| 4 | **Opening balances not signed off** | Wrong opening balances mean untrusted statements, the second-highest risk in the blueprint's register. | Operator + accountant |
| 5 | **Chart of accounts and tax treatment not confirmed** | The posting model is proposed, not validated. | Accountant |
| 6 | **Deposit rules not legally reviewed** | Interest basis and refund deadlines are deliberately not hardcoded and fail safe, but they must be configured from a reviewed rule pack before deposits are handled. | Legal adviser |
| 7 | **No restore exercise at production scale** | A 1-second restore of a 448 KB development database proves the procedure, not the recovery time. | Technical lead |
| 8 | **No independent security review** | Self-assessment is not assurance. | External |
| 9 | **No storage object backup** | Supabase database backups exclude Storage bytes. A restore today would reference documents that no longer exist. | Technical lead |

## Not blockers, but required before wider launch

- Load and capacity testing. Nothing is known about performance under load.
- Monitoring and alerting. Logs are produced; nothing consumes them.
- Rate limiting beyond sign-in (uploads, exports, invitation endpoints).
- Content Security Policy tightened to a nonce-based script policy.
- CSV onboarding import, PDF statements, document upload UI, inspection capture UI.
- Two complete billing cycles observed with a pilot operator, per the blueprint.

## What I would defend

These are implemented, enforced at the database, and covered by tests that fail
if the guarantee is broken:

* **Tenant isolation.** Composite foreign keys make a cross-organisation
  reference structurally impossible; RLS keys only on the verified session; the
  application role cannot bypass RLS and the app refuses to start if it could.
* **Financial integrity.** Journals balance inside the posting transaction via a
  deferred constraint trigger. Posted records are immutable. Over-allocation is
  impossible, including under concurrency. Duplicate billing is impossible.
* **Money representation.** Integer minor units throughout, with a test pinning
  the driver's behaviour so an upgrade cannot silently introduce floats.
* **MFA enforcement.** Part of permission resolution in the database, so a
  forgotten check in application code cannot bypass it.
* **Honest reporting.** Unverified payment evidence has no accounting effect.
  Undelivered email is never recorded as sent. Unscanned files are never
  reported as clean. Dashboard figures reconcile to the records they link to,
  asserted on every build.

## What I would not defend

* That the product is secure. It has not been reviewed by anyone but me.
* Any recovery time figure. The measured one is from a toy dataset.
* That the accounting model is correct for South African residential letting.
  An accountant has not looked at it.
* That the legal and privacy posture is compliant. A legal adviser has not
  looked at it.

## Pilot entry criteria

1. Blockers 1–3 closed (the product functions end to end).
2. Blockers 4–6 closed for the specific pilot operator.
3. Blocker 9 closed, and blocker 7 re-run at pilot scale.
4. Pilot runs on **anonymised historical data first**, with statements compared
   against the operator's existing records before any live data is imported.
5. Residents are invited only after two billing cycles reconcile.
