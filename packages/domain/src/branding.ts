import type { Sql } from '@propertyos/db';
import { recordAudit } from './audit';
import { invalid, notFound } from './errors';
import { INVOICE_TEMPLATES } from './invoice-templates';
import { requirePermission } from './permissions';

/**
 * What a landlord may change about how their console and portal look.
 *
 * The rule throughout this module: a choice from a list this product vetted,
 * never a value the administrator types. An arbitrary hex colour is one click
 * away from white-on-cream, and the person who suffers is a resident with low
 * vision reading a statement on a phone in daylight. An uploaded font file is
 * an executable format served from our own origin. Both are refused in favour
 * of a short list that was checked once, properly.
 *
 * The logo is the exception, because a brand mark cannot come from a list. It
 * gets the narrowest path this codebase has: two formats, validated from the
 * bytes rather than from the name or the browser's claim, a size ceiling, a
 * pixel ceiling, and a content type served from what the database recorded.
 *
 * Those two ceilings are a BACKSTOP, not a chore for the landlord. The upload
 * screen scales a picture to fit before it is sent — see `lib/fit-image.ts` —
 * so an ordinary upload of a 4000px brand asset simply works. What arrives
 * here oversized therefore did not come from that screen, and is refused
 * rather than resized: this layer is where the limits are enforced, and a
 * command that quietly rewrote what it was given would be a worse place to
 * put the convenience.
 */

/* ------------------------------------------------------------------ accents */

export interface BrandAccent {
  key: string;
  label: string;
  /** The ramp the interface actually uses: 50 and 100 for tints, 500/600/700 for solids. */
  tint: string;
  tintStrong: string;
  base: string;
  hover: string;
  text: string;
  /**
   * The same three in the dark theme. A tint that works behind dark text on
   * white is a glare on a dark surface, and a link colour dark enough to read
   * on white disappears on one — so dark is a stated palette, not a filter
   * applied to the light one. `base` and `hover` carry white text in both.
   */
  darkTint: string;
  darkTintStrong: string;
  darkText: string;
  /** Contrast of `text` on white, measured and recorded rather than assumed. */
  textContrastOnWhite: number;
}

/**
 * Seven accents, each one checked.
 *
 * `base` carries white text on a button, so it needs 4.5:1 against white at
 * the sizes buttons use. `text` is the colour a link takes on a white surface
 * and needs 4.5:1 as body text. The ratios are recorded here because a number
 * in a comment rots; `tests/unit/brand-accents.test.ts` recomputes every one of
 * them from the hex values and fails if any falls below the threshold.
 */
export const BRAND_ACCENTS: readonly BrandAccent[] = [
  {
    key: 'spike', label: 'Spike purple',
    tint: '#f4f1ff', tintStrong: '#ebe5ff',
    base: '#5f33ff', hover: '#4f27e0', text: '#4b21d8',
    darkTint: '#241a4d', darkTintStrong: '#2d2160', darkText: '#c3b0ff',
    textContrastOnWhite: 8.4,
  },
  {
    key: 'ink', label: 'Graphite',
    tint: '#eceef2', tintStrong: '#dfe3ea',
    base: '#343a46', hover: '#262b34', text: '#343a46',
    darkTint: '#26262b', darkTintStrong: '#303038', darkText: '#d2d6de',
    textContrastOnWhite: 11.4,
  },
  {
    key: 'ocean', label: 'Ocean',
    tint: '#e4f1f8', tintStrong: '#d3e7f3',
    base: '#10607f', hover: '#0c4c66', text: '#0f5a77',
    darkTint: '#0c2a38', darkTintStrong: '#113b4e', darkText: '#8fd0ea',
    textContrastOnWhite: 7.6,
  },
  {
    key: 'forest', label: 'Forest',
    tint: '#e6f2ea', tintStrong: '#d5e8dd',
    base: '#1f6a41', hover: '#175333', text: '#1d6440',
    darkTint: '#102a1d', darkTintStrong: '#163a28', darkText: '#8ddfae',
    textContrastOnWhite: 7.1,
  },
  {
    key: 'clay', label: 'Clay',
    tint: '#fbeae4', tintStrong: '#f6ddd2',
    base: '#a1442a', hover: '#843623', text: '#994027',
    darkTint: '#2f1710', darkTintStrong: '#422016', darkText: '#f3ab8e',
    textContrastOnWhite: 6.7,
  },
  {
    key: 'plum', label: 'Plum',
    tint: '#f8e9f1', tintStrong: '#f2dbe8',
    base: '#8a2e63', hover: '#71264f', text: '#842c5f',
    darkTint: '#2c1322', darkTintStrong: '#3c1a2e', darkText: '#f0a6cd',
    textContrastOnWhite: 8.4,
  },
  {
    key: 'slate', label: 'Slate blue',
    tint: '#e9edf7', tintStrong: '#dbe2f2',
    base: '#3a4b86', hover: '#2e3c6c', text: '#3a4b86',
    darkTint: '#1a2038', darkTintStrong: '#242d4c', darkText: '#b3c2ee',
    textContrastOnWhite: 8.3,
  },
] as const;

/* ----------------------------------------------------------------- typefaces */

export interface BrandTypeface {
  key: string;
  label: string;
  description: string;
}

/**
 * Four typeface settings, three of which cost a download and one of which
 * costs nothing at all.
 *
 * Every family here is served from this application. None is fetched from a
 * third party, so choosing one tells nobody outside this system that a page
 * was opened.
 */
export const BRAND_TYPEFACES: readonly BrandTypeface[] = [
  {
    key: 'default',
    label: 'Inter with Manrope headings',
    description: 'The default. A neutral interface face, with a second face carrying titles.',
  },
  {
    key: 'single',
    label: 'Inter throughout',
    description: 'One family everywhere. Quieter, and one font file lighter.',
  },
  {
    key: 'humanist',
    label: 'Source Sans with Fraunces headings',
    description: 'Warmer text, with a serif for titles. The most distinctive of the four.',
  },
  {
    key: 'system',
    label: 'Your device’s own fonts',
    description: 'No webfont is downloaded at all. Fastest, and different on every platform.',
  },
] as const;

export interface Branding {
  accent: string;
  typeface: string;
  /** Which invoice design this organisation issues. See INVOICE_TEMPLATES. */
  invoiceTemplate: string;
  hasLogo: boolean;
  logoWidth: number | null;
  logoHeight: number | null;
  logoFilename: string | null;
  /** What the logo actually is, read from its bytes at upload. */
  logoMime: 'image/png' | 'image/jpeg' | null;
  /** Changes whenever the logo does, so a cached one is never served stale. */
  logoVersion: string | null;
}

const DEFAULTS: Branding = {
  accent: 'spike',
  typeface: 'default',
  invoiceTemplate: 'classic',
  hasLogo: false,
  logoWidth: null,
  logoHeight: null,
  logoFilename: null,
  logoMime: null,
  logoVersion: null,
};

export function accentByKey(key: string | null | undefined): BrandAccent {
  return BRAND_ACCENTS.find((a) => a.key === key) ?? BRAND_ACCENTS[0]!;
}

export function typefaceByKey(key: string | null | undefined): BrandTypeface {
  return BRAND_TYPEFACES.find((t) => t.key === key) ?? BRAND_TYPEFACES[0]!;
}

/* --------------------------------------------------------------- image facts */

export interface ImageFacts {
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * What an uploaded file actually is, read from its own bytes.
 *
 * A browser's `file.type` is the browser's opinion, and a filename is the
 * uploader's. Neither decides what gets stored: this walks the file's own
 * structure, and anything it cannot parse as a plain PNG or JPEG is refused.
 *
 * Returning the dimensions is not a nicety — it is how a 20,000-pixel-wide
 * "logo" that would exhaust a renderer gets rejected before it is stored.
 *
 * SVG is deliberately absent. An SVG is a document that can carry script and
 * external references, and serving one from this origin would hand an
 * administrator a way to run code on every page their colleagues open.
 */
export function readImageFacts(bytes: Uint8Array): ImageFacts | null {
  if (bytes.length >= 24 && PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    // The IHDR chunk is required by the format to be the first one, so its
    // position is fixed: length and type at 8..16, then width and height.
    const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (type !== 'IHDR') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the segment markers to the frame header, which is the only place
    // the dimensions are stated. Anything malformed falls out as null rather
    // than being guessed at.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      // Standalone markers carry no payload.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (length < 2) return null;
      // SOF0..SOF15, excluding the two marker values in that range that are
      // not frame headers.
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8
        && marker !== 0xcc;
      if (isFrame) {
        const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
        if (width === 0 || height === 0) return null;
        return { mime: 'image/jpeg', width, height };
      }
      offset += 2 + length;
    }
    return null;
  }

  return null;
}

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_PIXELS = 1024;
export const LOGO_MIN_PIXELS = 16;

/* ---------------------------------------------------------------- the reads */

/** What this organisation looks like. Defaults when nothing has been chosen. */
export async function getBranding(tx: Sql, organisationId: string): Promise<Branding> {
  const [row] = await tx<
    { accent: string; typeface: string; invoice_template: string; has_logo: boolean;
      logo_width: number | null;
      logo_height: number | null; logo_filename: string | null;
      logo_mime: Branding['logoMime']; logo_version: string | null }[]
  >`
    select accent, typeface, invoice_template, logo_bytes is not null as has_logo,
           logo_width, logo_height, logo_filename, logo_mime,
           to_char(logo_updated_at, 'YYYYMMDDHH24MISS') as logo_version
      from organisation_branding
     where organisation_id = ${organisationId}::uuid
  `;
  if (!row) return DEFAULTS;
  return {
    accent: row.accent,
    typeface: row.typeface,
    invoiceTemplate: row.invoice_template,
    hasLogo: row.has_logo,
    logoWidth: row.logo_width,
    logoHeight: row.logo_height,
    logoFilename: row.logo_filename,
    logoMime: row.logo_mime,
    logoVersion: row.logo_version,
  };
}

/** The logo's bytes, for the route that serves it. */
export async function getLogo(
  tx: Sql, organisationId: string,
): Promise<{ bytes: Uint8Array; mime: string; version: string } | null> {
  const [row] = await tx<
    { logo_bytes: Uint8Array; logo_mime: string; logo_version: string }[]
  >`
    select logo_bytes, logo_mime,
           to_char(logo_updated_at, 'YYYYMMDDHH24MISS') as logo_version
      from organisation_branding
     where organisation_id = ${organisationId}::uuid and logo_bytes is not null
  `;
  if (!row) return null;
  return { bytes: row.logo_bytes, mime: row.logo_mime, version: row.logo_version };
}

/* -------------------------------------------------------------- the commands */

/** Sets the accent and typeface. Both must be keys this product offers. */
export async function setBranding(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { accent: string; typeface: string },
): Promise<Branding> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');
  if (!BRAND_ACCENTS.some((a) => a.key === input.accent)) {
    throw invalid('That is not one of the accent colours on offer.');
  }
  if (!BRAND_TYPEFACES.some((t) => t.key === input.typeface)) {
    throw invalid('That is not one of the typefaces on offer.');
  }

  await tx`
    insert into organisation_branding (organisation_id, accent, typeface, updated_by)
    values (${organisationId}::uuid, ${input.accent}, ${input.typeface}, ${actorUserId}::uuid)
    on conflict (organisation_id) do update set
      accent = excluded.accent, typeface = excluded.typeface,
      updated_at = now(), updated_by = excluded.updated_by
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'organisation_branding.updated', resourceType: 'organisation',
    resourceId: organisationId,
    after: { accent: input.accent, typeface: input.typeface },
  });
  return getBranding(tx, organisationId);
}

/**
 * Chooses which invoice design this organisation issues.
 *
 * A key from the vetted list, like the accent and the typeface, and for the
 * same reason: every design on that list was laid out and read, and carries
 * the payment reference, the due date and the landlord's identity. A layout an
 * administrator composed could lose one of those, and the person who then
 * cannot be told why their payment was not allocated is their tenant.
 */
export async function setInvoiceTemplate(
  tx: Sql, organisationId: string, actorUserId: string, template: string,
): Promise<Branding> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');
  if (!INVOICE_TEMPLATES.some((t) => t.key === template)) {
    throw invalid('That is not one of the invoice designs on offer.');
  }

  await tx`
    insert into organisation_branding (organisation_id, invoice_template, updated_by)
    values (${organisationId}::uuid, ${template}, ${actorUserId}::uuid)
    on conflict (organisation_id) do update set
      invoice_template = excluded.invoice_template,
      updated_at = now(), updated_by = excluded.updated_by
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'organisation_branding.invoice_template_set', resourceType: 'organisation',
    resourceId: organisationId,
    after: { invoiceTemplate: template },
  });
  return getBranding(tx, organisationId);
}

/**
 * Stores a logo, having first established what the file actually is.
 *
 * Nothing about the upload is taken on trust: not the extension, not the
 * content type the browser attached, not the size the form said it was. The
 * bytes are parsed, and a file that is not a plain PNG or JPEG is refused with
 * a reason rather than stored and served to everyone.
 */
export async function setLogo(
  tx: Sql, organisationId: string, actorUserId: string,
  input: { bytes: Uint8Array; filename?: string | null },
): Promise<Branding> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');

  if (input.bytes.length === 0) throw invalid('That file is empty.');
  if (input.bytes.length > LOGO_MAX_BYTES) {
    throw invalid(
      'This file is larger than 512 KB. The Appearance screen scales a picture down before '
      + 'sending it, so a file this size reached us another way.',
    );
  }

  const facts = readImageFacts(input.bytes);
  if (!facts) {
    throw invalid(
      'That file is not a PNG or a JPEG. SVG is not accepted, because an SVG can carry '
      + 'script that would then run on every page.',
    );
  }
  if (facts.width > LOGO_MAX_PIXELS || facts.height > LOGO_MAX_PIXELS) {
    throw invalid(
      `This picture is ${facts.width}×${facts.height}. The Appearance screen scales anything `
      + `larger than ${LOGO_MAX_PIXELS}px down before sending it, keeping its proportions, so `
      + 'a picture this size reached us another way.',
    );
  }
  if (facts.width < LOGO_MIN_PIXELS || facts.height < LOGO_MIN_PIXELS) {
    throw invalid(`A logo must be at least ${LOGO_MIN_PIXELS}px on each side.`);
  }

  const filename = (input.filename ?? '').trim().slice(0, 120) || null;
  await tx`
    insert into organisation_branding (
      organisation_id, logo_bytes, logo_mime, logo_width, logo_height,
      logo_filename, logo_updated_at, updated_by)
    values (
      ${organisationId}::uuid, ${Buffer.from(input.bytes)}, ${facts.mime},
      ${facts.width}, ${facts.height}, ${filename}, now(), ${actorUserId}::uuid)
    on conflict (organisation_id) do update set
      logo_bytes = excluded.logo_bytes, logo_mime = excluded.logo_mime,
      logo_width = excluded.logo_width, logo_height = excluded.logo_height,
      logo_filename = excluded.logo_filename, logo_updated_at = now(),
      updated_at = now(), updated_by = excluded.updated_by
  `;
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'organisation_branding.logo_set', resourceType: 'organisation',
    resourceId: organisationId,
    after: {
      mime: facts.mime, width: facts.width, height: facts.height,
      byteSize: input.bytes.length, filename,
    },
  });
  return getBranding(tx, organisationId);
}

/** Removes the logo, leaving the wordmark. */
export async function removeLogo(
  tx: Sql, organisationId: string, actorUserId: string,
): Promise<Branding> {
  await requirePermission(tx, organisationId, 'organisation.settings.manage');
  const [row] = await tx<{ organisation_id: string }[]>`
    update organisation_branding
       set logo_bytes = null, logo_mime = null, logo_width = null, logo_height = null,
           logo_filename = null, logo_updated_at = null,
           updated_at = now(), updated_by = ${actorUserId}::uuid
     where organisation_id = ${organisationId}::uuid and logo_bytes is not null
    returning organisation_id
  `;
  if (!row) throw notFound('There is no logo to remove.');
  await recordAudit(tx, {
    organisationId, actorUserId,
    action: 'organisation_branding.logo_removed', resourceType: 'organisation',
    resourceId: organisationId,
  });
  return getBranding(tx, organisationId);
}

/* ------------------------------------------------------- what a resident sees */

/**
 * The branding a resident of this lease should see.
 *
 * Goes through the security-definer function rather than the table, because a
 * resident has no membership and so no row-level read on the organisation's
 * own branding row.
 */
export async function getBrandingForLease(
  tx: Sql, leaseId: string,
): Promise<Branding> {
  const [row] = await tx<
    { accent: string; typeface: string; has_logo: boolean; invoice_template: string }[]
  >`
    select accent, typeface, has_logo, invoice_template
      from app.resident_branding(${leaseId}::uuid)
  `;
  if (!row) return DEFAULTS;
  return {
    ...DEFAULTS,
    accent: row.accent,
    typeface: row.typeface,
    hasLogo: row.has_logo,
    invoiceTemplate: row.invoice_template,
  };
}

/** The logo bytes for a resident's own landlord. */
export async function getLogoForLease(
  tx: Sql, leaseId: string,
): Promise<{ bytes: Uint8Array; mime: string; version: string } | null> {
  const [row] = await tx<
    { logo_bytes: Uint8Array; logo_mime: string; logo_updated_at: Date | null }[]
  >`
    select logo_bytes, logo_mime, logo_updated_at from app.resident_logo(${leaseId}::uuid)
  `;
  if (!row) return null;
  return {
    bytes: row.logo_bytes,
    mime: row.logo_mime,
    version: row.logo_updated_at ? row.logo_updated_at.toISOString() : 'current',
  };
}

/* ------------------------------------------- what a sign-in page may read */

/**
 * The branding for an organisation's own sign-in page, by slug.
 *
 * Nobody is signed in when this runs, so it goes through a security-definer
 * function that returns a colour, a typeface and whether a logo exists — and
 * nothing that names the organisation. An unknown slug, or one whose
 * organisation is suspended or closed, is indistinguishable from an
 * organisation that never chose any branding: both give the product's defaults.
 */
export async function getSignInBranding(tx: Sql, slug: string): Promise<Branding> {
  const [row] = await tx<{ accent: string; typeface: string; has_logo: boolean }[]>`
    select accent, typeface, has_logo from app.sign_in_branding(${slug})
  `;
  if (!row) return DEFAULTS;
  return { ...DEFAULTS, accent: row.accent, typeface: row.typeface, hasLogo: row.has_logo };
}

/** The logo bytes for that page. */
export async function getSignInLogo(
  tx: Sql, slug: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const [row] = await tx<{ logo_bytes: Uint8Array; logo_mime: string }[]>`
    select logo_bytes, logo_mime from app.sign_in_logo(${slug})
  `;
  return row ? { bytes: row.logo_bytes, mime: row.logo_mime } : null;
}
