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
import { VALUE_MARK_START, VALUE_MARK_END } from './lease-agreements';

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
  /**
   * The key terms, for the schedule on the first page.
   *
   * A lease is read twice: once in full before signing, and many times
   * afterwards to settle one question — when does it end, what is the rent, who
   * is on it. The schedule answers those without anyone hunting through the
   * clauses, and it is drawn from the same merged values as the body, so it
   * cannot disagree with the agreement it sits in front of.
   */
  summary?: { label: string; value: string }[];
}

/** A stretch of text, and whether it came from this lease rather than the template. */
interface Run { text: string; value: boolean }

/** Splits a line on the value markers into runs. */
function runsOf(line: string): Run[] {
  const runs: Run[] = [];
  let rest = line;
  while (rest.length > 0) {
    const start = rest.indexOf(VALUE_MARK_START);
    if (start === -1) { runs.push({ text: rest, value: false }); break; }
    if (start > 0) runs.push({ text: rest.slice(0, start), value: false });
    const end = rest.indexOf(VALUE_MARK_END, start + 1);
    if (end === -1) {
      // An unterminated mark can only mean a value containing a newline. Treat
      // the remainder as the value rather than printing a control character.
      runs.push({ text: rest.slice(start + 1), value: true });
      break;
    }
    runs.push({ text: rest.slice(start + 1, end), value: true });
    rest = rest.slice(end + 1);
  }
  return runs.filter((r) => r.text.length > 0);
}

/**
 * Greedy wrap over runs, so a value in bold wraps like any other words and keeps
 * its weight across the line break.
 *
 * Measured per run against the font it will actually be drawn in: bold glyphs
 * are wider, and wrapping everything as regular put bold text past the margin.
 */
function wrapRuns(runs: Run[], size: number, width: number): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  let used = 0;

  const push = (): void => { if (line.length > 0) { lines.push(line); line = []; used = 0; } };

  for (const run of runs) {
    const font = run.value ? 'Helvetica-Bold' as const : 'Helvetica' as const;
    // Keep the spaces: they belong between words, and dropping them around a
    // value ran it into the word before it.
    const pieces = run.text.split(/(\s+)/).filter((t) => t !== '');
    for (const piece of pieces) {
      const isSpace = /^\s+$/.test(piece);
      const w = measureText(piece, font, size);
      if (used + w > width && !(isSpace && used === 0)) {
        if (isSpace) continue;           // never start a line with a space
        if (used > 0) push();
        if (w > width) {
          // A single word wider than the column still has to go somewhere.
          let chunk = '';
          for (const ch of piece) {
            if (measureText(chunk + ch, font, size) > width) {
              lines.push([{ text: chunk, value: run.value }]);
              chunk = ch;
            } else chunk += ch;
          }
          line = [{ text: chunk, value: run.value }];
          used = measureText(chunk, font, size);
          continue;
        }
      }
      const last = line[line.length - 1];
      if (last && last.value === run.value) last.text += piece;
      else line.push({ text: piece, value: run.value });
      used += w;
    }
  }
  push();
  return lines.length > 0 ? lines : [[]];
}

/** Draws one wrapped line, run by run, and returns where it ended. */
function drawRuns(page: PdfPage, runs: Run[], x: number, y: number, size: number): void {
  let cursor = x;
  for (const run of runs) {
    const font = run.value ? 'Helvetica-Bold' as const : 'Helvetica' as const;
    page.text(run.text, cursor, y, { font, size });
    cursor += measureText(run.text, font, size);
  }
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

/**
 * An indented `label<gap>value` row, where the gap is two or more spaces used as
 * a column separator — "Name        {{landlord.name}}".
 *
 * Two spaces is what tells these apart from a clause that simply ran onto the
 * next line: prose wraps with single spaces, a column is aligned with several.
 */
const LABEL_ROW = /^[ \t]+(\S.*?)[ \t]{2,}(\S.*)$/;

/**
 * Rejoins a clause that the template's author hard-wrapped.
 *
 * Lease templates are written in a text box, so their paragraphs arrive broken
 * at whatever column the author was working to and indented underneath. Printing
 * those breaks verbatim gives a page of short ragged lines that stops looking
 * like a legal document, and re-wraps badly at any other page width. So a line
 * that is indented, is not a column row, and follows a clause is folded back
 * into the clause, and the renderer wraps the whole paragraph itself.
 *
 * Blank lines, headings and column rows all end a paragraph, so nothing is
 * glued to something it was never part of.
 */
export function reflow(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const indented = /^[ \t]+\S/.test(line);
    const previous = out[out.length - 1];
    const continues = indented
      && !LABEL_ROW.test(line)
      && previous !== undefined
      && previous.trim() !== ''
      && !LABEL_ROW.test(previous)
      && HEADING.test(previous.trim());
    if (continues) out[out.length - 1] = `${previous} ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

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

  // The schedule: the handful of terms anyone opening this document later is
  // actually looking for, with the values in bold.
  const summary = (context.summary ?? []).filter((row) => row.value.trim() !== '');
  if (summary.length > 0) {
    const labelWidth = 132;
    const valueWidth = columnWidth - labelWidth - 20;
    const rows = summary.map((row) => ({
      label: row.label,
      lines: wrap(row.value, 'Helvetica-Bold', BODY_SIZE, valueWidth),
    }));
    const height = rows.reduce((total, r) => total + LINE_HEIGHT * r.lines.length, 0) + 26;

    page.rect(MARGIN_X, y, columnWidth, height, { fill: 0.97 });
    page.text('SCHEDULE', MARGIN_X + 10, y + 12, { font: 'Helvetica-Bold', size: BODY_SIZE });
    let rowY = y + 12 + LINE_HEIGHT + 2;
    for (const row of rows) {
      page.text(row.label, MARGIN_X + 10, rowY, { size: BODY_SIZE, colour: 0.4 });
      row.lines.forEach((line, i) => page.text(
        line, MARGIN_X + 10 + labelWidth, rowY + i * LINE_HEIGHT,
        { font: 'Helvetica-Bold', size: BODY_SIZE },
      ));
      rowY += LINE_HEIGHT * row.lines.length;
    }
    y += height + 18;
  }

  for (const line of reflow(body)) {
    if (runsOf(line).map((r) => r.text).join('').trim() === '') {
      y += LINE_HEIGHT * 0.6;
      continue;
    }

    const column = LABEL_ROW.exec(line);
    if (column) {
      const [, label, value] = column;
      const labelX = MARGIN_X + 26;
      const valueX = labelX + 148;
      const wrapped = wrapRuns(runsOf(value!), BODY_SIZE, PAGE_WIDTH - MARGIN_X - valueX);
      room(LINE_HEIGHT * wrapped.length);
      page.text(runsOf(label!).map((r) => r.text).join(''), labelX, y, { size: BODY_SIZE, colour: 0.35 });
      wrapped.forEach((runs, i) => drawRuns(page, runs, valueX, y + i * LINE_HEIGHT, BODY_SIZE));
      y += LINE_HEIGHT * wrapped.length;
      continue;
    }

    const numbered = HEADING.exec(line.trim());
    if (numbered) {
      // Clause number in the gutter, body hanging beside it.
      const [, number, rest] = numbered;
      const indent = Math.min(46, 16 + number!.split('.').length * 10);
      const wrapped = wrapRuns(runsOf(rest!), BODY_SIZE, columnWidth - indent);
      room(LINE_HEIGHT * wrapped.length + 6);
      page.text(number!, MARGIN_X, y, { font: 'Helvetica-Bold', size: BODY_SIZE });
      wrapped.forEach((runs, i) =>
        drawRuns(page, runs, MARGIN_X + indent, y + i * LINE_HEIGHT, BODY_SIZE));
      y += LINE_HEIGHT * wrapped.length + 5;
      continue;
    }

    // A section heading is the template's own words, so it is tested and drawn
    // without the markers rather than with them.
    const plain = runsOf(line.trim()).map((r) => r.text).join('');
    if (ALL_CAPS_HEADING.test(plain) && plain.length < 70) {
      room(LINE_HEIGHT * 2.6);
      y += 10;
      page.text(plain, MARGIN_X, y, { font: 'Helvetica-Bold', size: BODY_SIZE + 1 });
      y += LINE_HEIGHT - 3;
      page.line(MARGIN_X, y, PAGE_WIDTH - MARGIN_X, y, { colour: 0.8 });
      y += 9;
      continue;
    }

    for (const runs of wrapRuns(runsOf(line), BODY_SIZE, columnWidth)) {
      room(LINE_HEIGHT);
      drawRuns(page, runs, MARGIN_X, y, BODY_SIZE);
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
