# ADR 0015 — Whose brand a resident sees

**Status:** accepted · **Date:** 2026-10-20

## Why

A landlord could already set an accent colour, a typeface and a logo (ADR
0012), and those reached the console sidebar and the resident portal's tenancy
pages. Everywhere else still said Spike: the browser tab, the icon in a
bookmark, the sign-in page their staff open several times a week, and — worst
of the lot — the header of every statement PDF a resident keeps, forwards to a
bank, or hands to an advice office.

A resident has a relationship with their landlord and none at all with this
product. So the rule is now stated plainly: **the landlord's mark is on the
surfaces their people and their residents look at; the attribution to this
product is one small line, once, in a place nobody has to look at it.**

## What changed

| Surface | Before | Now |
| --- | --- | --- |
| Statement PDF header | Spike wordmark in purple | The landlord's logo, or their name in their accent colour |
| Statement PDF footer | nothing of ours | `Prepared with Spike PropertyOS`, 7pt, grey |
| Console browser tab | `Overview · Spike PropertyOS` | `Overview · <organisation>` |
| Console favicon | the product's | the landlord's logo |
| Portal tab and icon | the product's | the landlord's trading name and logo |
| Portal shell header | Spike wordmark | the landlord's logo, where the resident has exactly ONE tenancy |
| Sign-in | one page, our brand | `/sign-in/<slug>` in their colours, with their mark |
| Portal footer | `Powered by Spike Technologies` | unchanged, deliberately |

## The PDF had to learn images

`packages/integrations/src/pdf.ts` could draw text, rules and filled
rectangles, which is all a statement needed until now. Embedding a logo meant
embedding an image, and the narrowness of what it accepts is the point:

- **Baseline JPEG** passes through untouched as `DCTDecode`, which is what PDF
  means by JPEG.
- **PNG** is inflated, unfiltered (all five scanline predictors), palettes
  expanded, alpha split out into an `/SMask`, and re-deflated as
  `FlateDecode`.
- **Everything else returns null**: 16-bit, interlaced, progressive JPEG, CMYK,
  SVG, a corrupt `IDAT`. A progressive JPEG is the clearest case — it renders
  in some viewers and not others, which is a worse failure than no logo.

A null is not an error. The header falls back to the landlord's name in text,
and a statement is never left ungenerated over a decoration. The unfiltering is
tested directly, per predictor, because getting it wrong produces an image that
is recognisably the right shape and visibly wrong — exactly the sort of fault
that survives a glance at a document.

## A sign-in page nobody is signed in to

`/sign-in/<slug>` renders before anybody has a session, so there is no
`auth.uid()` and every row-level policy on the branding table evaluates to
false — correctly. It therefore reads through `app.sign_in_branding(slug)` and
`app.sign_in_logo(slug)`, two security-definer functions whose returns are the
narrowest thing that does the job: an accent key, a typeface key, whether a
logo exists, and the bytes. **No name, no trading name, no status, no
timestamps.**

Three consequences, all deliberate:

1. **A wrong slug is indistinguishable from an unbranded organisation.** Both
   give the product's own neutral page, not a 404, so the URL cannot be walked
   to find out who this product's customers are.
2. **A suspended or closed organisation shows nothing.** Their staff cannot
   sign in to anything, and a working-looking page wearing their brand is a
   promise this product is no longer keeping for them.
3. **A correct guess shows that organisation's logo** — a mark they also
   publish on their own website. That is the exposure every vanity sign-in URL
   carries and the reason for having one. It is recorded here rather than
   discovered later.

The form behind the brand is byte-for-byte the same form. Credentials are not
scoped to an organisation (a person may work for two agencies on one login), so
a branded URL changes what the page looks like and nothing about what it
accepts or whom it admits.

## Deliberately not done

- **The portal footer keeps `Powered by Spike Technologies`.** Removing it was
  offered and not chosen. A resident is entitled to know what system holds
  their tenancy record.
- **Lease agreements carry no logo.** They are the signed record of an
  agreement; their layout is fixed and nothing decorative goes on one.
- **There is no invoice PDF to brand.** Sending an invoice emails the figures
  and a link to the resident's own statement, which stays correct as payments
  arrive (ADR 0014). The statement PDF is the document, and it is branded.
- **The portal shell stays neutral for a resident with two tenancies.** There
  is no single landlord to be branded as, so each landlord's mark appears only
  where it is unambiguous: inside the tenancy it belongs to.
- **Still no custom hex colours and no uploaded fonts**, for the reasons in
  ADR 0012. A white-label product that lets an administrator make a statement
  unreadable has not helped anybody.
