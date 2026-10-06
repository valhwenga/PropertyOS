/**
 * Rendering a merged lease agreement to PDF.
 *
 * The text comes from the organisation's own template; this only lays it out.
 * Layout rules follow how these documents are actually read and signed:
 *
 *  - numbered clauses keep their numbering and hang their body text;
 *  - every page carries an initials box, because parties initial each page;
 *  - the footer says the page number and that the document is a DRAFT until
 *    signed, so a generated PDF is never mistaken for a concluded agreement;
 *  - any placeholder that could not be filled is listed on a final page rather
 *    than left for someone to notice.
 */
import { PdfDocument, type PdfPage, measureText } from '@propertyos/integrations';

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 56;
const BODY_BOTTOM = PAGE_HEIGHT - 96;
const BODY_SIZE = 9.5;
const LINE_HEIGHT = 13.5;

export interface LeaseAgreementPdfContext {
  title: string;
  organisationName: string;
  leaseReference: string;
  generatedOn: string;
  missingFields: string[];
  /** Shown in the footer. A draft until the parties have signed it. */
  statusNote?: string;
}

/** Greedy wrap against the real glyph widths the PDF writer measures with. */
function wrap(text: string, font: 'Helvetica' | 'Helvetica-Bold', size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim() === '') { out.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, font, size) <= width) { line = candidate; continue; }
      if (line) out.push(line);
      // A single word wider than the column still has to go somewhere.
      if (measureText(word, font, size) > width) {
        let chunk = '';
        for (const ch of word) {
          if (measureText(chunk + ch, font, size) > width) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      } else line = word;
    }
    if (line) out.push(line);
  }
  return out;
}

const HEADING = /^(\d+(?:\.\d+)*)[.)]?\s+(\S.*)$/;
const ALL_CAPS_HEADING = /^[A-Z][A-Z0-9 ,'’&/()-]{3,}$/;

export function renderLeaseAgreementPdf(body: string, context: LeaseAgreementPdfContext): Uint8Array {
  const document = new PdfDocument({
    title: context.title,
    author: context.organisationName,
    subject: `Lease agreement for ${context.leaseReference}`,
  });

  const pages: PdfPage[] = [];
  let page = document.addPage(PAGE_WIDTH, PAGE_HEIGHT);
  pages.push(page);
  let y = MARGIN_TOP;

  const newPage = () => {
    page = document.addPage(PAGE_WIDTH, PAGE_HEIGHT);
    pages.push(page);
    y = MARGIN_TOP;
  };
  const room = (needed: number) => { if (y + needed > BODY_BOTTOM) newPage(); };

  // Title block.
  page.text(context.title, MARGIN_X, y, { font: 'Helvetica-Bold', size: 15 });
  y += 22;
  page.text(
    `${context.organisationName} · ${context.leaseReference} · generated ${context.generatedOn}`,
    MARGIN_X, y, { size: 8.5, colour: 0.35 },
  );
  y += 14;
  page.line(MARGIN_X, y, PAGE_WIDTH - MARGIN_X, y, { colour: 0.75 });
  y += 18;

  const columnWidth = PAGE_WIDTH - MARGIN_X * 2;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') { y += LINE_HEIGHT * 0.6; continue; }

    const numbered = HEADING.exec(line.trim());
    if (numbered) {
      // Clause number in the gutter, body hanging beside it.
      const [, number, rest] = numbered;
      const indent = Math.min(46, 16 + number!.split('.').length * 10);
      const wrapped = wrap(rest!, 'Helvetica', BODY_SIZE, columnWidth - indent);
      room(LINE_HEIGHT * wrapped.length + 6);
      page.text(number!, MARGIN_X, y, { font: 'Helvetica-Bold', size: BODY_SIZE });
      wrapped.forEach((w, i) => page.text(w, MARGIN_X + indent, y + i * LINE_HEIGHT, { size: BODY_SIZE }));
      y += LINE_HEIGHT * wrapped.length + 5;
      continue;
    }

    if (ALL_CAPS_HEADING.test(line.trim()) && line.trim().length < 70) {
      room(LINE_HEIGHT * 2);
      y += 6;
      page.text(line.trim(), MARGIN_X, y, { font: 'Helvetica-Bold', size: BODY_SIZE + 0.5 });
      y += LINE_HEIGHT + 2;
      continue;
    }

    const wrapped = wrap(line, 'Helvetica', BODY_SIZE, columnWidth);
    for (const w of wrapped) {
      room(LINE_HEIGHT);
      page.text(w, MARGIN_X, y, { size: BODY_SIZE });
      y += LINE_HEIGHT;
    }
  }

  // Anything the template asked for and the data could not supply.
  if (context.missingFields.length > 0) {
    newPage();
    page.text('INCOMPLETE FIELDS', MARGIN_X, y, { font: 'Helvetica-Bold', size: 11 });
    y += 18;
    for (const w of wrap(
      'The template asked for the values below and the system had none. Each appears ' +
        'in the document in square brackets. Complete them before the agreement is signed.',
      'Helvetica', BODY_SIZE, columnWidth,
    )) { page.text(w, MARGIN_X, y, { size: BODY_SIZE }); y += LINE_HEIGHT; }
    y += 6;
    for (const field of context.missingFields) {
      room(LINE_HEIGHT);
      page.text(`[${field}]`, MARGIN_X + 10, y, { font: 'Courier', size: BODY_SIZE });
      y += LINE_HEIGHT;
    }
  }

  // Footers, once the page count is known.
  const note = context.statusNote ?? 'DRAFT — not a concluded agreement until signed by all parties.';
  pages.forEach((p, index) => {
    const footerY = PAGE_HEIGHT - 58;
    p.line(MARGIN_X, footerY, PAGE_WIDTH - MARGIN_X, footerY, { colour: 0.85 });
    p.text(note, MARGIN_X, footerY + 6, { size: 7.5, colour: 0.4 });
    p.text(
      `Page ${index + 1} of ${pages.length}`,
      MARGIN_X, footerY + 6, { size: 7.5, colour: 0.4, align: 'right', width: PAGE_WIDTH - MARGIN_X * 2 },
    );
    // Parties initial every page.
    p.rect(PAGE_WIDTH - MARGIN_X - 86, footerY - 34, 86, 28, { fill: 1 });
    p.line(PAGE_WIDTH - MARGIN_X - 86, footerY - 6, PAGE_WIDTH - MARGIN_X, footerY - 6, { colour: 0.6 });
    p.text('Initial', PAGE_WIDTH - MARGIN_X - 84, footerY - 18, { size: 7, colour: 0.45 });
  });

  return document.build();
}
