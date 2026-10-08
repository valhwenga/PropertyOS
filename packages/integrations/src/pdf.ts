/**
 * A minimal PDF writer.
 *
 * PropertyOS produces one kind of PDF: a statement. That needs text in two
 * weights, horizontal rules, filled rectangles and right-aligned numbers — not
 * images, forms, annotations or embedded fonts. A general PDF library is a large
 * dependency for that surface, and this is ~250 lines with none. The trade-off
 * is recorded in ADR 0009.
 *
 * Output is PDF 1.4 using the standard Type 1 fonts, which every reader has, so
 * nothing is embedded and files stay small.
 *
 * KNOWN LIMIT: text is encoded as WinAnsi (Latin-1 plus the common typographic
 * marks). That covers English and Afrikaans, including diacritics. Characters
 * outside it — Greek, Cyrillic, CJK — are replaced with '?' rather than
 * producing a corrupt file. If a customer needs those, this writer must embed a
 * TrueType font, which it deliberately does not do today.
 */

export type FontName = 'Helvetica' | 'Helvetica-Bold' | 'Courier';

export interface TextOptions {
  font?: FontName;
  size?: number;
  /** 0–1 greyscale, or an [r, g, b] triple in 0–1. */
  colour?: number | [number, number, number];
  align?: 'left' | 'right';
  /** Required for right alignment: the x coordinate the text ends at. */
  width?: number;
}

interface Operation {
  render(): string;
}

/** Widths of the standard fonts, per 1000 units, for the characters we measure. */
const HELVETICA_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500, '{': 334, '|': 260, '}': 334,
};

/**
 * Helvetica-Bold, from the same Adobe metrics as the table above.
 *
 * It used to be approximated as Helvetica x 1.06, which is wrong in both
 * directions: a bold digit is exactly as wide as a regular one, while a bold 'i'
 * is a third wider. The error only mattered once bold and regular had to sit on
 * one line — a lease agreement setting its merged values in bold — where every
 * overestimate opened a gap before the next word, as in "Thandiwe Mokoena ." and
 * every underestimate ran the two together.
 */
const HELVETICA_BOLD_WIDTHS: Record<string, number> = {
  ' ': 278, '!': 333, '"': 474, '#': 556, '$': 556, '%': 889, '&': 722, "'": 238,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611,
  '@': 975, A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722,
  I: 278, J: 556, K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722,
  S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 333, '\\': 278, ']': 333, '^': 584, _: 556, '`': 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500, '{': 389, '|': 280, '}': 389,
};

/** Text width in points, from the font's own metrics. */
export function measureText(text: string, font: FontName, size: number): number {
  if (font === 'Courier') return text.length * 0.6 * size;
  const widths = font === 'Helvetica-Bold' ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
  let units = 0;
  for (const char of text) units += widths[char] ?? (font === 'Helvetica-Bold' ? 611 : 556);
  return (units / 1000) * size;
}

/**
 * Encodes a string as WinAnsi bytes, escaping the PDF string delimiters.
 * Unrepresentable characters become '?' rather than corrupting the stream.
 */
export function encodeWinAnsi(text: string): string {
  const SPECIAL: Record<string, number> = {
    '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
    '–': 0x96, '—': 0x97, '•': 0x95, '…': 0x85,
    '€': 0x80, '™': 0x99, '−': 0x2d,
  };
  let out = '';
  for (const char of text) {
    const code = SPECIAL[char] ?? char.codePointAt(0) ?? 0x3f;
    const byte = code <= 0xff ? code : 0x3f;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20) out += ' ';
    else out += String.fromCharCode(byte);
  }
  return out;
}

function colourOperator(colour: number | [number, number, number] | undefined, stroke = false): string {
  if (colour === undefined) return '';
  const op = stroke ? 'G' : 'g';
  const rgbOp = stroke ? 'RG' : 'rg';
  if (typeof colour === 'number') return `${colour.toFixed(3)} ${op}\n`;
  return `${colour.map((c) => c.toFixed(3)).join(' ')} ${rgbOp}\n`;
}

/** A single page being composed. Coordinates are points, origin top-left. */
export class PdfPage {
  private readonly operations: Operation[] = [];

  constructor(readonly width: number, readonly height: number) {}

  /** Converts a top-left y to PDF's bottom-left origin. */
  private y(top: number): number {
    return this.height - top;
  }

  text(content: string, x: number, top: number, options: TextOptions = {}): this {
    const font = options.font ?? 'Helvetica';
    const size = options.size ?? 10;
    const encoded = encodeWinAnsi(content);
    const offset =
      options.align === 'right' && options.width !== undefined
        ? options.width - measureText(content, font, size)
        : 0;
    const fontKey = font === 'Helvetica-Bold' ? 'F2' : font === 'Courier' ? 'F3' : 'F1';
    const y = this.y(top + size);

    this.operations.push({
      render: () =>
        `q\n${colourOperator(options.colour ?? 0)}BT\n/${fontKey} ${size} Tf\n` +
        `1 0 0 1 ${(x + offset).toFixed(2)} ${y.toFixed(2)} Tm\n(${encoded}) Tj\nET\nQ\n`,
    });
    return this;
  }

  line(x1: number, top1: number, x2: number, top2: number, options: { colour?: number; width?: number } = {}): this {
    this.operations.push({
      render: () =>
        `q\n${colourOperator(options.colour ?? 0.8, true)}${(options.width ?? 0.5).toFixed(2)} w\n` +
        `${x1.toFixed(2)} ${this.y(top1).toFixed(2)} m ${x2.toFixed(2)} ${this.y(top2).toFixed(2)} l S\nQ\n`,
    });
    return this;
  }

  rect(x: number, top: number, width: number, height: number, options: { fill?: number | [number, number, number] } = {}): this {
    this.operations.push({
      render: () =>
        `q\n${colourOperator(options.fill ?? 0.95)}` +
        `${x.toFixed(2)} ${this.y(top + height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f\nQ\n`,
    });
    return this;
  }

  contents(): string {
    return this.operations.map((o) => o.render()).join('');
  }
}

export interface PdfMetadata {
  title: string;
  author?: string;
  subject?: string;
}

/** Composes pages into a complete PDF file. */
export class PdfDocument {
  private readonly pages: PdfPage[] = [];

  constructor(private readonly metadata: PdfMetadata) {}

  /** A4 by default: 595.28 x 841.89 points. */
  addPage(width = 595.28, height = 841.89): PdfPage {
    const page = new PdfPage(width, height);
    this.pages.push(page);
    return page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  build(): Uint8Array {
    if (this.pages.length === 0) throw new Error('A PDF needs at least one page.');

    const objects: string[] = [];
    const add = (body: string): number => {
      objects.push(body);
      return objects.length; // 1-based object numbers
    };

    // Fonts are shared across pages.
    const helvetica = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const helveticaBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const courier = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

    // Reserve the Pages object number so page objects can point at their parent.
    const pagesNumber = objects.length + 1;
    objects.push(''); // placeholder, filled in below

    const pageNumbers: number[] = [];
    for (const page of this.pages) {
      const stream = page.contents();
      const contentNumber = add(
        `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
      );
      pageNumbers.push(
        add(
          `<< /Type /Page /Parent ${pagesNumber} 0 R ` +
            `/MediaBox [0 0 ${page.width.toFixed(2)} ${page.height.toFixed(2)}] ` +
            `/Resources << /Font << /F1 ${helvetica} 0 R /F2 ${helveticaBold} 0 R /F3 ${courier} 0 R >> >> ` +
            `/Contents ${contentNumber} 0 R >>`,
        ),
      );
    }

    objects[pagesNumber - 1] =
      `<< /Type /Pages /Count ${pageNumbers.length} ` +
      `/Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] >>`;

    const catalog = add(`<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`);
    const info = add(
      `<< /Title (${encodeWinAnsi(this.metadata.title)}) ` +
        `/Author (${encodeWinAnsi(this.metadata.author ?? 'Spike PropertyOS')}) ` +
        `/Subject (${encodeWinAnsi(this.metadata.subject ?? '')}) ` +
        `/Producer (Spike PropertyOS) /CreationDate (D:${pdfDate(new Date())}) >>`,
    );

    // Assemble, recording byte offsets for the cross-reference table.
    let body = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets: number[] = [];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(body, 'latin1'));
      body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });

    const xrefOffset = Buffer.byteLength(body, 'latin1');
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
    }
    const trailer =
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;

    return new Uint8Array(Buffer.from(body + xref + trailer, 'latin1'));
  }
}

function pdfDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}
