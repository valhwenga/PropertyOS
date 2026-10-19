# ADR 0012 — Appearance: a personal theme, an organisation's brand

**Status:** accepted · **Date:** 2026-10-19

## Why

Two different questions were being answered the same way, which is to say not
at all. Whether a person reads in light or dark is theirs; what colour the
product is, what it is set in, and whose mark is at the top of the resident
portal belongs to the landlord paying for it. Dark mode existed but lived in
one browser's `localStorage`, so it was lost on the next machine and shared
with whoever else used that one. Branding did not exist: every landlord's
residents signed into something wearing Spike's purple.

## What an administrator may change, and what they may not

| | Offered | Why |
|---|---|---|
| Accent colour | 7 vetted presets | A hex field is one click from white-on-cream. Each preset is checked against white, against the ink ramp and against the dark surface, by test, in both themes. |
| Typeface | 4 presets, all self-hosted | An uploaded font is an executable format served from our own origin, and new metrics reflow every table and every generated PDF. |
| Logo | PNG or JPEG upload | A brand mark cannot come from a list. So it gets the narrowest path in the codebase instead — see below. |
| Light/dark | Per person, not per organisation | Nobody should decide for a colleague how bright their screen is. |
| Layout, spacing, type scale | Not offered | These are what keep the five working screens legible, and a landlord cannot be asked to re-derive them. |

## How it is built

**The accent is CSS, not style attributes.** Each preset is a `[data-brand='…']`
rule in the one stylesheet every tenant shares, redefining the five steps the
interface actually paints with. The console shell and the portal's tenancy
layout set the attribute; nothing is generated per request, nothing is inlined
into the document, and a brand cannot smuggle CSS onto a page. Each accent has
its own dark palette, written in the same two duplicated blocks as the rest of
the dark theme, and `tests/unit/branding.test.ts` fails if the stylesheet and
the palette the domain offers drift apart.

**The theme follows the account.** `user_profiles.theme_choice` is the record;
saving it also writes a cookie, which the root layout reads to render
`data-theme` before the first paint. The no-flash script now resolves three
sources in order — this device's override, what the server rendered, then the
operating system — so a shared machine shows each colleague their own theme
and a device toggle still wins for the person who just clicked it.

**The logo takes a separate path from documents, deliberately.** A document in
this product is quarantined until a scanner clears it, which is right for a
resident's uploaded bank statement and useless for an image that must appear
on every page. So the bytes live on `organisation_branding`, and the narrowness
is the mitigation:

- PNG and JPEG only, established by parsing the file's own structure. The
  filename and the browser's content type are not consulted at all.
- SVG is refused in terms: it is a document that can carry script, and it would
  be served from this application's origin.
- 512 KB and 1024 px ceilings, enforced by the command and by a database
  constraint.
- Served from a route that authorises like every other page — the operator
  route under the caller's own membership, the resident route through
  `app.resident_logo`, which checks the lease first — with the content type the
  database recorded, `nosniff`, and `default-src 'none'; sandbox`.

Nothing here is a reason to drop the scanner for ordinary documents. It is a
reason that one tiny, heavily constrained class of file does not need it.

## What is deliberately unchanged

Generated documents — lease agreements and statement PDFs — carry no logo and
no accent. They are legal records with a fixed layout, and the moment a brand
mark is drawn onto one, a question arises about what else on the page the
landlord chose. Every branding change is recorded in the audit trail.
