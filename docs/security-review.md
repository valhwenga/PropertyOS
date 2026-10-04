# Security self-assessment

**This is a self-assessment by the implementer, not an independent review.** It
records what was considered and what was done, so that an external reviewer can
start from the gaps rather than rediscovering the basics.

Scope: the application, schema and policies as at 2026-10-04.

## Threat model coverage

| Threat (from the blueprint) | Control | Verified by |
| --- | --- | --- |
| Account takeover | Signed HTTP-only session cookie, scrypt password hashing, constant-time comparison, per-email and per-IP sign-in rate limiting, MFA for elevated roles | `db/mfa-enforcement.test.ts`; rate limiting is implemented but not load-tested |
| Incorrect resident linking | Invitation requires reviewing lease and recipient; a resident not party to the lease cannot be invited; the confirmed recipient is re-checked server side | `integration/operations.test.ts` |
| Cross-organisation access | Composite foreign keys carrying `organisation_id`; RLS on every customer table; non-superuser application role; startup self-check | `db/isolation.test.ts` (17 tests) |
| Bank detail changes | Only last four digits stored in the ordinary record; `verified_at`/`verified_by` on bank accounts | Schema only — the fresh-authentication flow for changing details is **not implemented** |
| Fabricated proof of payment | Evidence carries no accounting effect; no code path creates a receipt from it | `integration/rent-workflow.test.ts` |
| Duplicate webhook processing | Unique key on (provider, provider event id); unverified signatures recorded but never processed | `integration/acceptance.test.ts` |
| Malicious uploads | Extension blocklist, size limit, allowlisted content types, magic-byte sniffing, quarantine enforced by a check constraint | `integration/acceptance.test.ts` — **no malware scanner is configured** |
| Support access abuse | Time-limited, read-only, reason-required, customer-visible, audited; a writable or proxy session is rejected by policy | `db/isolation.test.ts`, `integration/reports.test.ts` |
| Financial tampering | Posted journals, journal lines and charge lines immutable; privileges revoked; corrections are linked reversals | `db/financial-invariants.test.ts` |

## Controls implemented

* **Transport and headers.** HSTS is the hosting layer's responsibility.
  `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` and a CSP are set in `next.config.ts`.
* **CSRF.** Next verifies the Origin header for Server Actions; `command()` adds
  an explicit same-origin check so the protection is visible and testable.
* **Secrets.** `SESSION_SECRET` must be 32+ bytes or the app throws.
  `SUPABASE_SERVICE_ROLE_KEY` is never read on a request path.
* **Logging.** Redaction applied to every field by name; message bodies never
  logged; correlation ids on every error.
* **Audit.** Written in the same transaction as the change, so an action cannot
  commit without its record. Payloads pass through `redact()`.
* **Error responses.** Stable codes, human-readable messages, correlation ids.
  Raw database errors never reach the client.

## Known weaknesses

1. **CSP permits `'unsafe-inline'` for scripts.** Required by Next's inline
   hydration bootstrap. A nonce-based policy is the correct fix.
2. **Rate limiting covers sign-in only.** Uploads, exports, statement generation
   and invitation acceptance are unthrottled.
3. **No account lockout or breach-password checking** in the local provider.
   Supabase provides these; the local provider is development-only and says so.
4. **Session revocation is time-based only.** There is no server-side session
   store, so a stolen cookie is valid until it expires (8 hours). Membership and
   portal-link revocation take effect immediately, which limits the blast radius,
   but the session itself cannot be killed.
5. **No malware scanning.** Quarantine is the compensating control.
6. **Storage object access is not implemented end to end**, so the signed-URL
   path has not been exercised against a real bucket.
7. **No penetration test, no dependency CVE scanning in CI, no SAST.**

## Recommended before production

1. Independent penetration test covering the isolation boundaries above.
2. Dependency scanning and SAST in CI.
3. Nonce-based CSP.
4. Server-side session revocation.
5. Rate limiting on uploads, exports and invitation endpoints.
6. Fresh-authentication flow for changing bank details.
7. A reviewed subset of OWASP ASVS, with the chosen level recorded in this repo.
