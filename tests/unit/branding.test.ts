/**
 * The two parts of branding that have to be right before anything is stored:
 * what an uploaded file actually is, and whether an accent is readable.
 *
 * Both are pure, so they are tested here rather than against a database.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BRAND_ACCENTS, BRAND_TYPEFACES, accentByKey, readImageFacts, typefaceByKey,
} from '@propertyos/domain';

/** A minimal but structurally real PNG: signature, then an IHDR chunk. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // 'IHDR'
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** A JPEG with one APP0 segment before the frame header, as a camera writes. */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof0 = [
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    ...new Array(8).fill(0),
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0]);
}

/* ------------------------------------------------------------ what it is */

describe('readImageFacts', () => {
  it('reads a PNG’s own dimensions', () => {
    expect(readImageFacts(png(512, 128)))
      .toEqual({ mime: 'image/png', width: 512, height: 128 });
  });

  it('reads a JPEG’s dimensions past its other segments', () => {
    expect(readImageFacts(jpeg(300, 90)))
      .toEqual({ mime: 'image/jpeg', width: 300, height: 90 });
  });

  it('refuses an SVG, whatever it is called', () => {
    // The dangerous case: a vector "logo" is a document that can carry script,
    // and it would be served from this application's own origin.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(readImageFacts(svg)).toBeNull();
  });

  it('refuses HTML dressed up as an image', () => {
    const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
    expect(readImageFacts(html)).toBeNull();
  });

  it('refuses a file whose PNG signature is not followed by a header', () => {
    const broken = png(10, 10);
    broken.set([0x6e, 0x6f, 0x70, 0x65], 12); // 'nope' instead of 'IHDR'
    expect(readImageFacts(broken)).toBeNull();
  });

  it('refuses a truncated file rather than guessing', () => {
    expect(readImageFacts(png(64, 64).slice(0, 18))).toBeNull();
    expect(readImageFacts(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(readImageFacts(new Uint8Array())).toBeNull();
  });

  it('refuses a JPEG that declares a zero dimension', () => {
    expect(readImageFacts(jpeg(0, 50))).toBeNull();
  });
});

/* ------------------------------------------------------- whether it reads */

/** WCAG relative luminance, from the hex this product would actually paint. */
function luminance(hex: string): number {
  const channel = (pair: string) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(hex.slice(1, 3));
  const g = channel(hex.slice(3, 5));
  const b = channel(hex.slice(5, 7));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe('brand accents', () => {
  it('every accent carries white text on its solid at 4.5:1 or better', () => {
    // The accent is the colour of every primary button in the product. An
    // administrator choosing one must not be able to make "Record receipt"
    // unreadable.
    for (const accent of BRAND_ACCENTS) {
      expect(contrast(accent.base, '#ffffff'), `${accent.key} base`)
        .toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent.hover, '#ffffff'), `${accent.key} hover`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every accent reads as link text on a white surface', () => {
    for (const accent of BRAND_ACCENTS) {
      expect(contrast(accent.text, '#ffffff'), `${accent.key} text`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every tint still carries the ink ramp’s darkest text', () => {
    // Tints back status chips and selected navigation, which carry dark text.
    for (const accent of BRAND_ACCENTS) {
      expect(contrast(accent.tint, '#16161a'), `${accent.key} tint`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('records a contrast figure that matches the measured one', () => {
    // A number in a table drifts the moment somebody adjusts a hex. This is
    // what keeps the documented figure honest.
    for (const accent of BRAND_ACCENTS) {
      expect(contrast(accent.text, '#ffffff'), `${accent.key}`)
        .toBeCloseTo(accent.textContrastOnWhite, 0);
    }
  });

  it('falls back to the default rather than throwing on an unknown key', () => {
    expect(accentByKey('nonsense').key).toBe('spike');
    expect(accentByKey(null).key).toBe('spike');
    expect(typefaceByKey(undefined).key).toBe('default');
    expect(BRAND_TYPEFACES.map((t) => t.key))
      .toEqual(['default', 'single', 'humanist', 'system']);
  });
});


/* --------------------------------------------- the palette and the stylesheet */

const STYLES = readFileSync(
  fileURLToPath(new URL('../../packages/ui/src/styles.css', import.meta.url)),
  'utf8',
);

/** The declarations inside one rule, as a map. */
function rule(selector: string): Record<string, string> {
  const at = STYLES.indexOf(`${selector} {`);
  if (at === -1) return {};
  const body = STYLES.slice(at + selector.length + 2, STYLES.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const line of body.split(';')) {
    const [key, value] = line.split(':');
    if (key?.trim() && value?.trim()) out[key.trim()] = value.trim();
  }
  return out;
}

describe('the accents in the stylesheet', () => {
  it('states every accent the product offers', () => {
    // A key stored in the database with no rule here renders as the default
    // purple, which looks like the save silently failed.
    for (const accent of BRAND_ACCENTS) {
      expect(Object.keys(rule(`[data-brand='${accent.key}']`)), accent.key)
        .not.toEqual([]);
    }
  });

  it('paints exactly the colours the domain says it will', () => {
    for (const accent of BRAND_ACCENTS) {
      expect(rule(`[data-brand='${accent.key}']`), accent.key).toEqual({
        '--color-spike-50': accent.tint,
        '--color-spike-100': accent.tintStrong,
        '--color-spike-500': accent.base,
        '--color-spike-600': accent.hover,
        '--color-spike-700': accent.text,
      });
    }
  });

  it('states the same dark palette for the chosen theme and the system fallback', () => {
    // The same duplication the rest of the dark theme has, and the same risk:
    // the two must not drift.
    for (const accent of BRAND_ACCENTS) {
      const chosen = rule(`:root[data-theme='dark'] [data-brand='${accent.key}']`);
      const fallback = rule(`:root:not([data-theme]) [data-brand='${accent.key}']`);
      expect(chosen, accent.key).toEqual({
        '--color-spike-50': accent.darkTint,
        '--color-spike-100': accent.darkTintStrong,
        '--color-spike-700': accent.darkText,
      });
      expect(fallback, accent.key).toEqual(chosen);
    }
  });

  it('every accent’s dark link colour reads on the dark surface', () => {
    for (const accent of BRAND_ACCENTS) {
      expect(contrast(accent.darkText, '#1a1a1e'), `${accent.key} dark text`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it('declares a rule for every typeface that is not the default', () => {
    for (const typeface of BRAND_TYPEFACES) {
      if (typeface.key === 'default') continue;
      expect(STYLES, typeface.key).toContain(`[data-typeface='${typeface.key}']`);
    }
  });
});
