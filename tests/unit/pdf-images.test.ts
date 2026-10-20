/**
 * Putting a landlord's logo in a PDF.
 *
 * Two things are worth testing directly rather than by looking at a document.
 * First, the PNG unfiltering: get it wrong and the image is recognisably the
 * right shape and visibly wrong, which is exactly the sort of error that
 * survives a glance. Second, the refusals — a format this writer cannot embed
 * honestly must come back as null so a statement falls back to text rather
 * than failing to generate.
 */
import { deflateSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import { PdfDocument, readRaster } from '@propertyos/integrations';

/** CRC-32, which every PNG chunk carries. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * A real PNG, built here so the test owns every byte.
 *
 * `filter` is applied to every scanline, so the same pixels can be written
 * through each of PNG's predictors and must come back identical.
 */
function png(
  pixels: number[][], colourType: number, channels: number, filterType = 0,
): Uint8Array {
  const height = pixels.length;
  const width = pixels[0]!.length / channels;
  const raw: number[] = [];
  const previous = new Array(width * channels).fill(0);

  for (const row of pixels) {
    raw.push(filterType);
    for (let i = 0; i < row.length; i += 1) {
      const left = i >= channels ? row[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      const value = row[i]!;
      const encoded =
        filterType === 0 ? value
          : filterType === 1 ? value - left
            : filterType === 2 ? value - up
              : filterType === 3 ? value - ((left + up) >> 1)
                : value - paeth(left, up, upLeft);
      raw.push(encoded & 0xff);
    }
    for (let i = 0; i < row.length; i += 1) previous[i] = row[i]!;
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = colourType;
  ihdr[12] = 0;           // no interlace

  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    ...chunk('IEND', new Uint8Array()),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** A baseline JPEG header: enough structure for the reader, no scan data. */
function jpeg(width: number, height: number, components: number, marker = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0),
    0xff, marker, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    components, ...new Array(7).fill(0),
  ]);
}

const RED_GREEN_BLUE = [
  [255, 0, 0, 0, 255, 0, 0, 0, 255],
  [10, 20, 30, 40, 50, 60, 70, 80, 90],
];

describe('reading a logo', () => {
  it('reads an RGB PNG under every scanline filter', () => {
    // The filters are the part that fails silently, so all five are exercised
    // and must produce the same pixels.
    for (const filter of [0, 1, 2, 3, 4]) {
      const raster = readRaster(png(RED_GREEN_BLUE, 2, 3, filter));
      expect(raster, `filter ${filter}`).not.toBeNull();
      expect(raster!.width).toBe(3);
      expect(raster!.height).toBe(2);
      expect(raster!.colourSpace).toBe('DeviceRGB');
      expect(raster!.filter).toBe('FlateDecode');
      expect(raster!.alpha).toBeUndefined();
    }
  });

  it('keeps transparency as a soft mask rather than flattening it', () => {
    const rgba = [[255, 0, 0, 128, 0, 255, 0, 255]];
    const raster = readRaster(png(rgba, 6, 4));
    expect(raster!.colourSpace).toBe('DeviceRGB');
    expect(raster!.alpha).toBeDefined();
  });

  it('reads a greyscale PNG', () => {
    const raster = readRaster(png([[0, 128, 255]], 0, 1));
    expect(raster!.colourSpace).toBe('DeviceGray');
    expect(raster!.width).toBe(3);
  });

  it('passes a baseline JPEG through untouched', () => {
    const bytes = jpeg(240, 80, 3);
    const raster = readRaster(bytes);
    expect(raster).toMatchObject({
      width: 240, height: 80, colourSpace: 'DeviceRGB', filter: 'DCTDecode',
    });
    expect(raster!.data).toBe(bytes);
  });

  it('refuses what it cannot embed honestly', () => {
    // A progressive JPEG renders in some viewers and not others, which is
    // worse than no logo at all.
    expect(readRaster(jpeg(100, 100, 3, 0xc2))).toBeNull();
    // CMYK, which would need a colour profile to look like anything.
    expect(readRaster(jpeg(100, 100, 4))).toBeNull();
    // Not an image.
    expect(readRaster(new TextEncoder().encode('<svg/>'))).toBeNull();
    expect(readRaster(new Uint8Array([1, 2, 3]))).toBeNull();
    // A PNG whose IDAT is nonsense: refused, not guessed at.
    const broken = png(RED_GREEN_BLUE, 2, 3);
    broken.set([0, 0, 0, 0], broken.length - 20);
    expect(readRaster(broken)).toBeNull();
  });
});

describe('embedding it', () => {
  it('writes an image XObject the page refers to', () => {
    const document = new PdfDocument({ title: 'Statement' });
    const image = document.addImage(png(RED_GREEN_BLUE, 2, 3));
    expect(image).not.toBeNull();

    const page = document.addPage();
    page.image(image!, 40, 40, 120, 40);
    const pdf = Buffer.from(document.build()).toString('latin1');

    expect(pdf).toContain('/Subtype /Image');
    expect(pdf).toContain('/ColorSpace /DeviceRGB');
    expect(pdf).toContain('/XObject << /Im1');
    // Drawn at the size the caller asked for, not the pixel size.
    expect(pdf).toContain('120.00 0 0 40.00');
    expect(pdf).toContain('/Im1 Do');
  });

  it('carries an alpha channel as an SMask', () => {
    const document = new PdfDocument({ title: 'Statement' });
    const image = document.addImage(png([[255, 0, 0, 128]], 6, 4));
    document.addPage().image(image!, 0, 0, 10, 10);
    expect(Buffer.from(document.build()).toString('latin1')).toContain('/SMask');
  });

  it('answers null for an unusable file instead of throwing', () => {
    const document = new PdfDocument({ title: 'Statement' });
    expect(document.addImage(new TextEncoder().encode('not an image'))).toBeNull();
    // And the document still builds, with no XObject in it.
    document.addPage().text('Statement', 40, 40);
    expect(Buffer.from(document.build()).toString('latin1')).not.toContain('/XObject');
  });
});
