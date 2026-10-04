# ADR 0009 — Writing the external adapters by hand

**Status:** accepted · **Date:** 2026-10-04

## Context

Three blockers made the product non-functional: no email delivery, no malware
scanning, and no object storage transfer. Each is normally solved by adding a
library.

## Decision

All three are implemented directly, with no new runtime dependency.

| Adapter | What it speaks | Why not a library |
| --- | --- | --- |
| SMTP | ESMTP with STARTTLS and AUTH PLAIN/LOGIN | PropertyOS sends transactional messages to one recipient. A general mail library brings attachment handling, templating, connection pooling and a dependency tree, for a surface we do not use. |
| ClamAV | INSTREAM over TCP | The protocol is a four-byte length prefix, the chunks, a zero-length terminator and one reply line. A wrapper would be larger than the client. |
| Storage | Supabase Storage REST, plus a local filesystem adapter | The Supabase client is a large dependency for four HTTP calls, and it pulls in browser-oriented code we must keep away from the service role key. |

Each is around 150 lines, has no transitive dependencies, and is tested against
a **real server** — an in-process SMTP server for the mail client, a mock clamd
for the scanner, the actual filesystem plus live HTTP for storage.

The trade-off is real: edge cases a mature library has already met are ones we
will meet ourselves. That is recorded in `docs/known-limitations.md`, and
swapping any of these for a library later is a single file change behind the
existing interface.

## What "sent" and "clean" now mean

The point of writing these was to make two claims defensible.

**`sent`** is written only when the server issued a 2xx to the final `.` of the
DATA block — the moment it accepts responsibility for the message. Anything
else is `failed`, carrying the server's own words. The adapter never upgrades a
timeout, a connection error or a 4xx into a success.

**`clean`** is written only when clamd replied `OK`. A scanner that is
unreachable, times out, errors, or returns something unrecognised produces
`failed`, and a failed scan leaves the document **quarantined** — which the
database refuses to let anyone share, independently of this code.

Both are asserted by tests that kill the server mid-conversation and check we
report failure rather than silence.

## Download authorisation

Storage decides nothing about who may read a file. The order is fixed:

1. identity from the signed session;
2. `authoriseDownload` under the caller's own RLS context, so an unreachable
   document gives the same "not found" as a nonexistent one;
3. the access grant recorded in the same transaction;
4. only then a signed URL, valid for five minutes.

The local adapter's links are HMAC tokens over `(key, expiry)`. Changing either
invalidates the token, which is asserted over HTTP: a tampered key gives 403, an
extended expiry gives 403, an expired link gives 410. Objects are served
`application/octet-stream`, `nosniff`, `Content-Disposition: attachment`, with a
sandbox CSP — an uploaded file is never rendered in the application's origin.
