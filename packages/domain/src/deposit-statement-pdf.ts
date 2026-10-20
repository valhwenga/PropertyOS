import { PdfDocument, type PdfImage } from '@propertyos/integrations';
import { accentByKey } from './branding';
import { formatDayMonthYear } from './dates';
import type { DepositStatement } from './deposit-statement';
import type { InvoiceLandlord } from './invoice-document';
import { formatMinor } from './money';

/**
 * The deposit statement, as a document a tenant can keep.
 *
 * It exists for one moment: the end of a lease, when a deposit comes back
 * smaller than it went in. What settles that conversation is not a balance —
 * it is the list. Every receipt, every interest credit, every deduction with
 * the reason recorded for it, and what remains, in the order it happened.
 *
 * So the deductions are not summarised. A single line reading "deductions
 * R4,200" is precisely the document that starts the argument this one is meant
 * to end.
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = 0.08;
const MUTED = 0.45;
const RULE = 0.85;
const FAINT = 0.62;
const WARN: [number, number, number] = [0.54, 0.34, 0];

export interface DepositStatementPdfContext {
  landlord: InvoiceLandlord;
  accent?: string | null;
  logo?: Uint8Array | null;
}

export function renderDepositStatementPdf(
  statement: DepositStatement, context: DepositStatementPdfContext,
): Uint8Array {
  const name = context.landlord.tradingName?.trim()
    || context.landlord.legalName?.trim()
    || 'Your landlord';

  const document = new PdfDocument({
    title: `Deposit statement ${statement.leaseReference}`,
    author: name,
    subject: `Deposit held for ${statement.propertyName} / ${statement.unitCode}`,
  });

  const accent = accentByKey(context.accent);
  const colour = hexToRgb(accent.base);
  const tint = hexToRgb(accent.tint);

  let image: PdfImage | null = null;
  let logoWidth = 0;
  let logoHeight = 0;
  if (context.logo && context.logo.length > 0) {
    image = document.addImage(context.logo);
    if (image) {
      const scale = Math.min(26 / image.height, 170 / image.width, 1);
      logoWidth = image.width * scale;
      logoHeight = image.height * scale;
    }
  }

  const page = document.addPage(PAGE_WIDTH, PAGE_HEIGHT);
  const money = (value: bigint) => formatMinor(value, statement.currencyCode);
  const symbol = statement.currencyCode === 'ZAR' ? 'R' : `${statement.currencyCode} `;

  /* ---------------------------------------------------------------- header */

  let y = MARGIN;
  if (image) {
    page.image(image, MARGIN, y, logoWidth, logoHeight);
    y += logoHeight + 4;
    page.text(name, MARGIN, y, { size: 9, colour: MUTED });
    y += 12;
  } else {
    page.text(truncate(name, 42), MARGIN, y, {
      font: 'Helvetica-Bold', size: 16, colour,
    });
    y += 22;
  }

  page.text('DEPOSIT STATEMENT', PAGE_WIDTH - MARGIN, MARGIN + 2, {
    align: 'right', width: 0, font: 'Helvetica-Bold', size: 12, colour: MUTED,
  });

  const identity = [
    context.landlord.legalName && context.landlord.legalName !== context.landlord.tradingName
      ? context.landlord.legalName : null,
    context.landlord.physicalAddress?.split('\n')[0] ?? null,
    [context.landlord.phone, context.landlord.email].filter(Boolean).join('  ·  ') || null,
  ].filter((line): line is string => Boolean(line));
  for (const line of identity) {
    page.text(truncate(line, 70), MARGIN, y, { size: 8, colour: MUTED });
    y += 10;
  }

  y = Math.max(y, MARGIN + 60);
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { colour: RULE, width: 1 });
  y += 14;

  page.text(statement.residentName, MARGIN, y, {
    font: 'Helvetica-Bold', size: 12, colour: INK,
  });
  page.text(`${statement.propertyName} / ${statement.unitCode}`, MARGIN, y + 16,
    { size: 9.5, colour: MUTED });
  page.text(`Lease ${statement.leaseReference}`, MARGIN, y + 29,
    { size: 9, font: 'Courier', colour: MUTED });

  const right = PAGE_WIDTH - MARGIN - 170;
  page.text('Deposit agreed', right, y, { size: 8, colour: MUTED });
  page.text(symbol + money(statement.requiredMinor), PAGE_WIDTH - MARGIN, y, {
    align: 'right', width: 0, size: 9.5, font: 'Helvetica-Bold', colour: INK,
  });
  page.text('Account opened', right, y + 18, { size: 8, colour: MUTED });
  page.text(formatDayMonthYear(statement.openedOn), PAGE_WIDTH - MARGIN, y + 18, {
    align: 'right', width: 0, size: 9.5, colour: INK,
  });
  if (statement.closedOn) {
    page.text('Account closed', right, y + 36, { size: 8, colour: MUTED });
    page.text(formatDayMonthYear(statement.closedOn), PAGE_WIDTH - MARGIN, y + 36, {
      align: 'right', width: 0, size: 9.5, colour: INK,
    });
  }
  y += 60;

  /* ------------------------------------------------------------- the list */

  page.rect(MARGIN, y - 5, CONTENT_WIDTH, 18, { fill: 0.94 });
  const head = { size: 7.5, font: 'Helvetica-Bold' as const, colour: MUTED };
  page.text('DATE', MARGIN + 8, y, head);
  page.text('WHAT HAPPENED', MARGIN + 80, y, head);
  page.text('IN', PAGE_WIDTH - MARGIN - 150, y, { ...head, align: 'right', width: 60 });
  page.text('OUT', PAGE_WIDTH - MARGIN - 8, y, { ...head, align: 'right', width: 0 });
  y += 22;

  if (statement.events.length === 0) {
    page.text(
      'Nothing has been recorded against this deposit yet.',
      MARGIN + 8, y, { size: 9, colour: MUTED },
    );
    y += 18;
  }

  for (const event of statement.events) {
    page.text(formatDayMonthYear(event.effectiveOn), MARGIN + 8, y,
      { size: 8.5, colour: MUTED });
    page.text(truncate(event.label, 34), MARGIN + 80, y,
      { size: 9.5, colour: INK, font: 'Helvetica-Bold' });

    page.text(symbol + money(event.amountMinor),
      event.reduces ? PAGE_WIDTH - MARGIN - 8 : PAGE_WIDTH - MARGIN - 90, y,
      { align: 'right', width: 0, size: 9.5, colour: INK });
    y += 12;

    // The reason, in the words that were recorded. This is the line the whole
    // document exists for.
    if (event.description) {
      page.text(truncate(event.description, 86), MARGIN + 80, y, { size: 8, colour: FAINT });
      y += 11;
    }
    if (event.reference) {
      page.text(`Paid with reference ${truncate(event.reference, 40)}`, MARGIN + 80, y,
        { size: 8, colour: FAINT });
      y += 11;
    }
    y += 4;
    page.line(MARGIN, y - 4, PAGE_WIDTH - MARGIN, y - 4, { colour: 0.92 });

    if (y > PAGE_HEIGHT - MARGIN - 190) {
      // One page, deliberately: the summary and the list belong together, so
      // a deposit with more history than fits says so rather than silently
      // dropping the rest.
      page.text(
        'More entries exist than fit on one page. Ask your landlord for the full history.',
        MARGIN + 8, y + 4, { size: 8, font: 'Helvetica-Bold', colour: WARN },
      );
      y += 18;
      break;
    }
  }

  /* ----------------------------------------------------------- the summary */

  y += 8;
  const rows: Array<[string, bigint]> = [
    ['Deposit received', statement.receivedMinor],
    ['Interest credited to you', statement.interestMinor],
    ['Deducted', -statement.deductedMinor],
    ['Transferred to rent owed', -statement.transferredToRentMinor],
    ['Refunded to you', -statement.refundedMinor],
  ];
  for (const [label, value] of rows) {
    if (value === 0n) continue;
    page.text(label, MARGIN + 8, y, { size: 9, colour: MUTED });
    const magnitude = value < 0n ? -value : value;
    page.text(`${value < 0n ? '− ' : ''}${symbol}${money(magnitude)}`,
      PAGE_WIDTH - MARGIN - 8, y, { align: 'right', width: 0, size: 9.5, colour: INK });
    y += 14;
  }

  page.rect(MARGIN, y, CONTENT_WIDTH, 32, { fill: tint });
  page.text('Still held for you', MARGIN + 10, y + 10, {
    font: 'Helvetica-Bold', size: 11, colour: INK,
  });
  page.text(symbol + money(statement.heldMinor), PAGE_WIDTH - MARGIN - 10, y + 10, {
    align: 'right', width: 0, font: 'Helvetica-Bold', size: 14, colour,
  });
  y += 44;

  if (!statement.reconciles) {
    page.text(
      'This deposit shows less than nothing held, which means something was recorded in '
      + 'error. Please tell your landlord.',
      MARGIN, y, { size: 8.5, font: 'Helvetica-Bold', colour: WARN },
    );
    y += 16;
  }

  page.text(
    'A deposit is held separately from rent. It does not reduce what is owed on your '
    + 'account, and nothing here is applied to an invoice.',
    MARGIN, y, { size: 8.5, colour: INK },
  );

  /* ------------------------------------------------------------- footer */

  const footer = PAGE_HEIGHT - MARGIN - 30;
  page.line(MARGIN, footer, PAGE_WIDTH - MARGIN, footer, { colour: RULE });
  page.text(
    `Deposit statement · lease ${statement.leaseReference} · `
    + `${statement.propertyName} / ${statement.unitCode}`,
    MARGIN, footer + 8, { size: 7.5, colour: MUTED },
  );
  page.text('Prepared with Spike PropertyOS', PAGE_WIDTH - MARGIN, footer + 8, {
    align: 'right', width: 0, size: 7, colour: 0.72,
  });
  page.text(
    'Every entry above traces to a posted record. Keep this with your lease.',
    MARGIN, footer + 20, { size: 7.5, colour: FAINT },
  );

  return document.build();
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
