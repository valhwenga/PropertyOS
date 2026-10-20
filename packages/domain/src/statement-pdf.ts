import { formatDayMonthYear, formatDayMonthYearTime } from './dates';
import { PdfDocument, type PdfImage, type PdfPage } from '@propertyos/integrations';
import { accentByKey } from './branding';
import { formatMinor } from './money';
import type { Statement } from './statements';

/**
 * Renders a resident statement as a PDF.
 *
 * This is the document a resident keeps, forwards to a bank, or hands to an
 * advice office in a dispute, so it carries everything needed to read it
 * without the application: the cut-off, the opening balance and where it came
 * from, every posted line, the closing receivable, and the separate figures for
 * unapplied credit and deposit held.
 *
 * It renders only what `buildStatement` produced. There is no second query and
 * no recomputation here, so the PDF cannot disagree with the screen.
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = 0.08;
const MUTED = 0.45;
const RULE = 0.85;

const COLUMNS = {
  date: MARGIN,
  reference: MARGIN + 74,
  description: MARGIN + 150,
  debit: MARGIN + 300,
  credit: MARGIN + 378,
  balance: MARGIN + 456,
} as const;
const NUMBER_WIDTH = 66;

export interface StatementPdfContext {
  organisationName: string;
  propertyLabel: string;
  residentName: string;
  /** Shown so a resident knows who to contact. Optional. */
  contactEmail?: string;
  contactPhone?: string;
  /**
   * The landlord's own logo, if they have uploaded one. A statement is the
   * document a resident keeps, so it carries their landlord's mark rather than
   * this product's. Anything the PDF writer cannot embed honestly comes back as
   * null there and the header falls back to the landlord's name in text — a
   * statement never fails to generate over a decoration.
   */
  logo?: Uint8Array | null;
  /** The accent key from their branding, for the one coloured mark on the page. */
  accent?: string | null;
}

/** The landlord's mark, resolved once and drawn on every page. */
interface Brand {
  image: PdfImage | null;
  /** Points, already fitted to the header band. */
  width: number;
  height: number;
  colour: [number, number, number];
}

// Tall enough to read, short enough that the landlord's name still fits
// between the mark and the rule under the header band.
const LOGO_MAX_HEIGHT = 26;
const LOGO_MAX_WIDTH = 190;

function resolveBrand(document: PdfDocument, context: StatementPdfContext): Brand {
  const colour = hexToRgb(accentByKey(context.accent).base);
  const image = context.logo && context.logo.length > 0
    ? document.addImage(context.logo) : null;
  if (!image) return { image: null, width: 0, height: 0, colour };

  // Fit inside the band without distorting it: whichever limit bites first.
  const scale = Math.min(
    LOGO_MAX_HEIGHT / image.height, LOGO_MAX_WIDTH / image.width, 1,
  );
  return {
    image,
    width: image.width * scale,
    height: image.height * scale,
    colour,
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

export function renderStatementPdf(statement: Statement, context: StatementPdfContext): Uint8Array {
  const document = new PdfDocument({
    title: `Statement ${statement.leaseReference} to ${statement.cutOff}`,
    author: context.organisationName,
    subject: `Resident statement for ${context.propertyLabel}`,
  });

  const money = (value: bigint) => formatMinor(value, statement.currencyCode);
  const symbol = statement.currencyCode === 'ZAR' ? 'R' : `${statement.currencyCode} `;

  // Added to the document once, before any page refers to it.
  const brand = resolveBrand(document, context);

  let page = document.addPage(PAGE_WIDTH, PAGE_HEIGHT);
  let y = drawHeader(page, statement, context, brand);
  let pageNumber = 1;

  // Opening balance, always shown even when zero: a statement that silently
  // starts from nothing is indistinguishable from one that lost its history.
  y = drawTableHead(page, y);
  page.text('Opening balance', COLUMNS.description, y, { font: 'Helvetica-Bold', colour: INK });
  page.text(
    statement.openingBalanceSource === 'prior_activity'
      ? 'brought forward from earlier activity'
      : 'no earlier activity',
    COLUMNS.description, y + 11, { size: 7.5, colour: MUTED },
  );
  page.text(symbol + money(statement.openingBalanceMinor), COLUMNS.balance, y, {
    align: 'right', width: NUMBER_WIDTH, font: 'Helvetica-Bold', colour: INK,
  });
  y += 26;

  for (const line of statement.lines) {
    // Keep the closing block and the footer together rather than orphaning them.
    if (y > PAGE_HEIGHT - MARGIN - 120) {
      drawFooter(page, statement, context, pageNumber);
      page = document.addPage(PAGE_WIDTH, PAGE_HEIGHT);
      pageNumber += 1;
      y = drawContinuationHeader(page, statement, context, brand, pageNumber);
      y = drawTableHead(page, y);
    }

    page.text(formatDayMonthYear(line.entryDate), COLUMNS.date, y, { size: 8.5, colour: MUTED });
    page.text(line.reference, COLUMNS.reference, y, { size: 8.5, font: 'Courier', colour: MUTED });
    page.text(truncate(line.description, 46), COLUMNS.description, y, { size: 9, colour: INK });
    if (line.debitMinor > 0n) {
      page.text(money(line.debitMinor), COLUMNS.debit, y, {
        align: 'right', width: NUMBER_WIDTH, size: 9, colour: INK,
      });
    }
    if (line.creditMinor > 0n) {
      page.text(money(line.creditMinor), COLUMNS.credit, y, {
        align: 'right', width: NUMBER_WIDTH, size: 9, colour: INK,
      });
    }
    page.text(money(line.runningBalanceMinor), COLUMNS.balance, y, {
      align: 'right', width: NUMBER_WIDTH, size: 9, colour: INK,
    });
    y += 16;
    page.line(MARGIN, y - 4, PAGE_WIDTH - MARGIN, y - 4, { colour: 0.92 });
  }

  // Closing block.
  y += 6;
  page.rect(MARGIN, y - 6, CONTENT_WIDTH, 30, { fill: 0.96 });
  page.text('Closing balance due', COLUMNS.description, y + 2, { font: 'Helvetica-Bold', size: 11, colour: INK });
  page.text(symbol + money(statement.closingReceivableMinor), COLUMNS.balance, y + 2, {
    align: 'right', width: NUMBER_WIDTH, font: 'Helvetica-Bold', size: 11, colour: INK,
  });
  y += 42;

  // Figures that are deliberately NOT part of the balance due. Showing them
  // beside it, labelled, is how a resident avoids concluding their deposit has
  // paid their rent.
  if (statement.unappliedCreditMinor > 0n || statement.depositHeldMinor > 0n) {
    page.text('Held separately from the balance above', MARGIN, y, {
      font: 'Helvetica-Bold', size: 9, colour: INK,
    });
    y += 14;
    if (statement.unappliedCreditMinor > 0n) {
      page.text('Credit not yet applied to a charge', COLUMNS.description, y, { size: 9, colour: MUTED });
      page.text(symbol + money(statement.unappliedCreditMinor), COLUMNS.balance, y, {
        align: 'right', width: NUMBER_WIDTH, size: 9, colour: INK,
      });
      y += 14;
    }
    if (statement.depositHeldMinor > 0n) {
      page.text('Deposit held', COLUMNS.description, y, { size: 9, colour: MUTED });
      page.text(symbol + money(statement.depositHeldMinor), COLUMNS.balance, y, {
        align: 'right', width: NUMBER_WIDTH, size: 9, colour: INK,
      });
      y += 12;
      page.text(
        'Your deposit is held as a separate liability. It does not reduce the balance due.',
        COLUMNS.description, y, { size: 7.5, colour: MUTED },
      );
      y += 16;
    }
    y += 8;
  }

  // Unverified evidence, stated plainly so nobody believes a balance moved.
  if (statement.pendingEvidence.length > 0) {
    const claimed = statement.pendingEvidence.reduce((sum, e) => sum + e.claimedAmountMinor, 0n);
    page.rect(MARGIN, y - 6, CONTENT_WIDTH, 42, { fill: [0.99, 0.96, 0.89] });
    page.text('Payment awaiting verification', MARGIN + 10, y, {
      font: 'Helvetica-Bold', size: 9, colour: [0.54, 0.34, 0],
    });
    page.text(
      `We have received proof of payment totalling ${symbol}${money(claimed)}.`,
      MARGIN + 10, y + 13, { size: 8.5, colour: INK },
    );
    page.text(
      'It has not yet been confirmed against our bank records, so it is NOT included above.',
      MARGIN + 10, y + 24, { size: 8.5, colour: INK },
    );
    y += 54;
  }

  drawFooter(page, statement, context, pageNumber);
  return document.build();
}

function drawHeader(
  page: PdfPage, statement: Statement, context: StatementPdfContext, brand: Brand,
): number {
  const marked = drawMark(page, context, brand, MARGIN, 16);

  page.text('STATEMENT', PAGE_WIDTH - MARGIN, MARGIN + 2, {
    align: 'right', width: 0, font: 'Helvetica-Bold', size: 12, colour: MUTED,
  });

  // Under a logo the landlord's name is still worth stating in words, because a
  // mark is not a legal name. Where the mark IS the name, saying it twice is
  // just noise.
  if (brand.image) {
    page.text(context.organisationName, MARGIN, MARGIN + marked + 4, { size: 9, colour: MUTED });
  }

  const y = MARGIN + 58;
  page.line(MARGIN, y - 10, PAGE_WIDTH - MARGIN, y - 10, { colour: RULE, width: 1 });

  page.text(context.residentName, MARGIN, y, { font: 'Helvetica-Bold', size: 12, colour: INK });
  page.text(context.propertyLabel, MARGIN, y + 16, { size: 9.5, colour: MUTED });
  page.text(`Lease ${statement.leaseReference}`, MARGIN, y + 29, {
    size: 9, font: 'Courier', colour: MUTED,
  });

  const rightColumn = PAGE_WIDTH - MARGIN - 160;
  page.text('Statement date', rightColumn, y, { size: 8, colour: MUTED });
  page.text(formatDayMonthYear(statement.cutOff), rightColumn, y + 11, { size: 9.5, colour: INK });
  page.text('Currency', rightColumn, y + 29, { size: 8, colour: MUTED });
  page.text(statement.currencyCode, rightColumn, y + 40, { size: 9.5, colour: INK });

  return y + 68;
}

function drawContinuationHeader(
  page: PdfPage, statement: Statement, context: StatementPdfContext, brand: Brand,
  pageNumber: number,
): number {
  drawMark(page, context, brand, MARGIN, 11);
  page.text(
    `Statement ${statement.leaseReference} continued — page ${pageNumber}`,
    PAGE_WIDTH - MARGIN - 240, MARGIN + 2, { size: 9, colour: MUTED },
  );
  return MARGIN + 34;
}

/**
 * The landlord's mark at the top of a page, and how tall it turned out.
 *
 * A logo is drawn at the size it fits; with no logo — or one this writer could
 * not embed — the landlord's own name takes its place in their accent colour.
 * Either way the document says whose it is, and no page carries a mark for
 * software the resident has no relationship with.
 */
function drawMark(
  page: PdfPage, context: StatementPdfContext, brand: Brand, top: number, size: number,
): number {
  if (brand.image) {
    // The continuation pages get a smaller mark, in the same proportions.
    const scale = Math.min(size / 16, 1);
    const width = brand.width * scale;
    const height = brand.height * scale;
    page.image(brand.image, MARGIN, top, width, height);
    return height;
  }
  page.text(truncate(context.organisationName, 48), MARGIN, top, {
    font: 'Helvetica-Bold', size, colour: brand.colour,
  });
  return size;
}

function drawTableHead(page: PdfPage, y: number): number {
  page.rect(MARGIN, y - 5, CONTENT_WIDTH, 18, { fill: 0.94 });
  const options = { size: 7.5, font: 'Helvetica-Bold' as const, colour: MUTED };
  page.text('DATE', COLUMNS.date, y, options);
  page.text('REFERENCE', COLUMNS.reference, y, options);
  page.text('DESCRIPTION', COLUMNS.description, y, options);
  page.text('DEBIT', COLUMNS.debit, y, { ...options, align: 'right', width: NUMBER_WIDTH });
  page.text('CREDIT', COLUMNS.credit, y, { ...options, align: 'right', width: NUMBER_WIDTH });
  page.text('BALANCE', COLUMNS.balance, y, { ...options, align: 'right', width: NUMBER_WIDTH });
  return y + 22;
}

function drawFooter(
  page: PdfPage, statement: Statement, context: StatementPdfContext, pageNumber: number,
): void {
  const y = PAGE_HEIGHT - MARGIN - 34;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { colour: RULE });

  const contact = [context.contactEmail, context.contactPhone].filter(Boolean).join('  ·  ');
  if (contact) {
    page.text(`Questions about this statement: ${contact}`, MARGIN, y + 8, { size: 7.5, colour: MUTED });
  }
  page.text(
    `Generated ${formatDayMonthYearTime(statement.generatedAt, 'UTC')} UTC  ·  page ${pageNumber}`,
    MARGIN, y + 19, { size: 7.5, colour: MUTED },
  );
  page.text(
    'Every line traces to a posted charge or an applied payment.',
    PAGE_WIDTH - MARGIN - 230, y + 19, { size: 7.5, colour: MUTED },
  );
  // Small, once, at the bottom: the landlord's brand is the one at the top.
  page.text('Prepared with Spike PropertyOS', PAGE_WIDTH - MARGIN, y + 8, {
    align: 'right', width: 0, size: 7, colour: 0.62,
  });
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
