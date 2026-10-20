import { inflateSync, deflateSync } from 'node:zlib';

/**
 * Reading a logo well enough to put it in a PDF.
 *
 * PDF embeds images as streams with a filter, and it understands two of the
 * ones that matter here directly: `DCTDecode` is JPEG, byte for byte, and
 * `FlateDecode` is zlib — which is what a PNG already uses, although not in a
 * form PDF can take unaltered. So a JPEG is passed through and a PNG is
 * decoded, unfiltered and re-compressed.
 *
 * The scope is deliberately narrow: this exists so a landlord's logo appears on
 * their own statement, not to be an image library. Anything it cannot read
 * honestly — a 16-bit PNG, an interlaced one, a progressive JPEG, CMYK — comes
 * back as null, and the caller falls back to the landlord's name in text. A
 * statement must never fail to generate because of a decoration.
 */

export interface RasterImage {
  width: number;
  height: number;
  colourSpace: 'DeviceRGB' | 'DeviceGray';
  /** The PDF stream filter for `data`. */
  filter: 'DCTDecode' | 'FlateDecode';
  /** The image stream, ready to embed. */
  data: Uint8Array;
  /** Soft mask (alpha), FlateDecode DeviceGray, when the image has one. */
  alpha?: Uint8Array;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** What this image is, or null when it is not something we can embed honestly. */
export function readRaster(bytes: Uint8Array): RasterImage | null {
  if (bytes.length > 8 && PNG_MAGIC.every((b, i) => bytes[i] === b)) return readPng(bytes);
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return readJpeg(bytes);
  return null;
}

/* --------------------------------------------------------------------- JPEG */

/**
 * A JPEG goes in as it arrived.
 *
 * PDF's DCTDecode is baseline JPEG. A PROGRESSIVE one (SOF2) renders in some
 * viewers and not others, which is a worse failure than not showing a logo, so
 * it is refused here rather than shipped and hoped for.
 */
function readJpeg(bytes: Uint8Array): RasterImage | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return null;

    // SOF0 baseline and SOF1 extended sequential only.
    if (marker === 0xc0 || marker === 0xc1) {
      const precision = bytes[offset + 4]!;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      const components = bytes[offset + 9]!;
      if (precision !== 8 || width === 0 || height === 0) return null;
      if (components !== 1 && components !== 3) return null; // CMYK is not worth guessing at.
      return {
        width,
        height,
        colourSpace: components === 1 ? 'DeviceGray' : 'DeviceRGB',
        filter: 'DCTDecode',
        data: bytes,
      };
    }
    if (marker >= 0xc2 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) return null;
    offset += 2 + length;
  }
  return null;
}

/* ---------------------------------------------------------------------- PNG */

interface PngHeader {
  width: number; height: number; bitDepth: number; colourType: number; interlace: number;
}

function readPng(bytes: Uint8Array): RasterImage | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header: PngHeader | null = null;
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!,
    );
    const start = offset + 8;
    if (start + length > bytes.length) return null;

    if (type === 'IHDR') {
      header = {
        width: view.getUint32(start),
        height: view.getUint32(start + 4),
        bitDepth: bytes[start + 8]!,
        colourType: bytes[start + 9]!,
        interlace: bytes[start + 12]!,
      };
    } else if (type === 'PLTE') {
      palette = bytes.subarray(start, start + length);
    } else if (type === 'tRNS') {
      paletteAlpha = bytes.subarray(start, start + length);
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + length + 4; // skip the CRC
  }

  if (!header || idat.length === 0) return null;
  // 8 bits per channel, no interlace. Everything else falls back to text.
  if (header.bitDepth !== 8 || header.interlace !== 0) return null;
  if (![0, 2, 3, 4, 6].includes(header.colourType)) return null;
  if (header.colourType === 3 && !palette) return null;

  const channels = header.colourType === 0 ? 1
    : header.colourType === 2 ? 3
      : header.colourType === 3 ? 1
        : header.colourType === 4 ? 2
          : 4;

  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c)))));
  } catch {
    return null; // Corrupt or unsupported compression: not our problem to guess at.
  }

  const unfiltered = unfilter(raw, header.width, header.height, channels);
  if (!unfiltered) return null;

  // Split into colour and alpha, expanding a palette where there is one.
  const pixels = header.width * header.height;
  let colour: Uint8Array;
  let alpha: Uint8Array | null = null;
  let colourSpace: RasterImage['colourSpace'];

  if (header.colourType === 3) {
    colour = new Uint8Array(pixels * 3);
    colourSpace = 'DeviceRGB';
    if (paletteAlpha) alpha = new Uint8Array(pixels).fill(255);
    for (let i = 0; i < pixels; i += 1) {
      const index = unfiltered[i]!;
      colour[i * 3] = palette![index * 3] ?? 0;
      colour[i * 3 + 1] = palette![index * 3 + 1] ?? 0;
      colour[i * 3 + 2] = palette![index * 3 + 2] ?? 0;
      if (alpha && index < paletteAlpha!.length) alpha[i] = paletteAlpha![index]!;
    }
  } else if (header.colourType === 6 || header.colourType === 4) {
    const colourChannels = header.colourType === 6 ? 3 : 1;
    colour = new Uint8Array(pixels * colourChannels);
    alpha = new Uint8Array(pixels);
    colourSpace = colourChannels === 3 ? 'DeviceRGB' : 'DeviceGray';
    for (let i = 0; i < pixels; i += 1) {
      for (let c = 0; c < colourChannels; c += 1) {
        colour[i * colourChannels + c] = unfiltered[i * channels + c]!;
      }
      alpha[i] = unfiltered[i * channels + colourChannels]!;
    }
  } else {
    colour = unfiltered;
    colourSpace = header.colourType === 2 ? 'DeviceRGB' : 'DeviceGray';
  }

  return {
    width: header.width,
    height: header.height,
    colourSpace,
    filter: 'FlateDecode',
    data: new Uint8Array(deflateSync(Buffer.from(colour))),
    ...(alpha ? { alpha: new Uint8Array(deflateSync(Buffer.from(alpha))) } : {}),
  };
}

/**
 * Undoes PNG's per-scanline filters.
 *
 * Each row begins with a filter byte saying how its bytes were predicted from
 * the row above and the pixel to the left. Getting this wrong produces an image
 * that is recognisably the right shape and visibly wrong, which is why it is
 * tested directly rather than by eye.
 */
function unfilter(
  raw: Uint8Array, width: number, height: number, channels: number,
): Uint8Array | null {
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  const out = new Uint8Array(stride * height);
  let source = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[source]!;
    source += 1;
    const target = row * stride;
    const above = target - stride;

    for (let i = 0; i < stride; i += 1) {
      const value = raw[source + i]!;
      const left = i >= channels ? out[target + i - channels]! : 0;
      const up = row > 0 ? out[above + i]! : 0;
      const upLeft = row > 0 && i >= channels ? out[above + i - channels]! : 0;

      let restored: number;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + up; break;
        case 3: restored = value + ((left + up) >> 1); break;
        case 4: restored = value + paeth(left, up, upLeft); break;
        default: return null;
      }
      out[target + i] = restored & 0xff;
    }
    source += stride;
  }
  return out;
}

/** The PNG predictor: whichever of left, above or above-left is closest. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
