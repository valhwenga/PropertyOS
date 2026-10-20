import { PdfDocument, measureText, type PdfImage, type PdfPage } from '@propertyos/integrations';
import { accentByKey } from './branding';
import { formatDayMonthYear } from './dates';
import type { InvoiceDocument } from './invoice-document';
import { invoiceTemplateByKey } from './invoice-templates';
import { formatMinor } from './money';

/**
 * Renders an invoice as a PDF, in whichever design the landlord chose.
 *
 * Three designs, and the thing they have in common is more important than what
 * separates them. Every one of them carries, in a place a reader cannot miss:
 *
 *   * who is charging — registered name, registration and VAT numbers where
 *     they exist, and an address;
 *   * which home it is for, by name, unit and street address;
 *   * what was charged, line by line, with proration shown as the arithmetic
 *     rather than as a number nobody can check;
 *   * the amount, the due date, and
 *   * THE REFERENCE the tenant must quote — which is the lease reference,
 *     because that is what reconciliation actually matches a payment on. An
 *     invoice with a reference nobody matches is how a payment goes missing.
 *
 * What differs is weight, colour and arrangement. A design cannot remove a
 * fact, which is why this is a short list rather than a layout editor:
 * `tests/unit/invoice-layout.test.ts` renders all three and fails if any of
 * them drops one.
 *
 * It renders what `loadInvoice…` read and does no second query, so the PDF
 * cannot disagree with the screen; and it computes nothing except the sum of
 * the lines, which it checks against the posted total rather than replacing it.
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = 0.08;
const MUTED = 0.45;
const RULE = 0.85;
const FAINT = 0.62;

export interface InvoicePdfContext {
  /** One of INVOICE_TEMPLATES; an unknown key falls back to the first. */
  template?: string | null;
  accent?: string | null;
  /** The landlord's logo. Anything unembeddable falls back to their name. */
  logo?: Uint8Array | null;
  /**
   * Set only for the sample an administrator previews when choosing a design.
   * It prints across the page, because a specimen that can be mistaken for a
   * demand is worse than no specimen.
   */
  sample?: boolean;
}

interface Brand {
  image: PdfImage | null;
  width: number;
  height: number;
  colour: [number, number, number];
  tint: [number, number, number];
}

const LOGO_MAX_HEIGHT = 30;
const LOGO_MAX_WIDTH = 170;

export function renderInvoicePdf(
  invoice: InvoiceDocument, context: InvoicePdfContext = {},
): Uint8Array {
  const template = invoiceTemplateByKey(context.template).key;
  const landlordName = nameOf(invoice);

  const document = new PdfDocument({
    title: `Invoice ${invoice.documentNumber}`,
    author: landlordName,
    subject: `${invoice.propertyName} / ${invoice.unitCode} — lease ${invoice.leaseReference}`,
  });

  const accent = accentByKey(context.accent);
  const brand: Brand = {
    image: null, width: 0, height: 0,
    colour: hexToRgb(accent.base),
    tint: hexToRgb(accent.tint),
  };
  const image = context.logo && context.logo.length > 0
    ? document.addImage(context.logo) : null;
  if (image) {
    const scale = Math.min(LOGO_MAX_HEIGHT / image.height, LOGO_MAX_WIDTH / image.width, 1);
    brand.image = image;
    brand.width = image.width * scale;
    brand.height = image.height * scale;
  }

  const page = document.addPage(PAGE_WIDTH, PAGE_HEIGHT);
  const money = (value: bigint) => formatMinor(value, invoice.currencyCode);
  const symbol = invoice.currencyCode === 'ZAR' ? 'R' : `${invoice.currencyCode} `;

  let y = template === 'modern'
    ? drawModernHeader(page, invoice, brand, landlordName)
    : template === 'compact'
      ? drawCompactHeader(page, invoice, brand, landlordName)
      : drawClassicHeader(page, invoice, brand, landlordName);

  y = drawParties(page, invoice, y, template);
  y = drawLines(page, invoice, y, template, brand, money, symbol);
  y = drawTotal(page, invoice, y, template, brand, money, symbol);
  drawPaymentInstructions(page, invoice, y, template, brand);
  drawFooter(page, invoice, template);

  // A specimen must not be mistakable for a demand, so it says so twice: once
  // across the page and once in the footer.
  if (context.sample) drawSampleMark(page, brand);

  return document.build();
}

/* ------------------------------------------------------------------ pieces */

/** Whichever name the landlord has given, preferring the one they trade under. */
function nameOf(invoice: InvoiceDocument): string {
  return invoice.landlord.tradingName?.trim()
    || invoice.landlord.legalName?.trim()
    || 'Your landlord';
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** The mark, or the landlord's name where there is none to draw. */
function drawMark(
  page: PdfPage, brand: Brand, name: string, x: number, top: number, size: number,
  colour: number | [number, number, number],
): number {
  if (brand.image) {
    const scale = Math.min(size / 16, 1);
    page.image(brand.image, x, top, brand.width * scale, brand.height * scale);
    return brand.height * scale;
  }
  page.text(truncate(name, 42), x, top, { font: 'Helvetica-Bold', size, colour });
  return size;
}

/** The landlord's identity, as lines. Nothing unrecorded is invented. */
function landlordLines(invoice: InvoiceDocument): string[] {
  const { landlord } = invoice;
  const lines: string[] = [];
  // The registered name, where it differs from the name they trade under.
  if (landlord.legalName && landlord.legalName !== landlord.tradingName) {
    lines.push(landlord.legalName);
  }
  if (landlord.physicalAddress) lines.push(...landlord.physicalAddress.split('\n').slice(0, 3));
  const identifiers = [
    landlord.registrationNumber ? `Reg ${landlord.registrationNumber}` : null,
    landlord.vatNumber ? `VAT ${landlord.vatNumber}` : null,
  ].filter(Boolean).join('  ·  ');
  if (identifiers) lines.push(identifiers);
  const contact = [landlord.phone, landlord.email].filter(Boolean).join('  ·  ');
  if (contact) lines.push(contact);
  if (landlord.agentName) {
    lines.push(`Managed by ${landlord.agentName}${
      landlord.agentContact ? ` · ${landlord.agentContact}` : ''}`);
  }
  return lines;
}

function periodLabel(invoice: InvoiceDocument): string | null {
  if (!invoice.periodStart || !invoice.periodEnd) return null;
  return `${formatDayMonthYear(invoice.periodStart)} to ${formatDayMonthYear(invoice.periodEnd)}`;
}

function documentTitle(invoice: InvoiceDocument): string {
  if (invoice.status === 'draft') return 'PRO FORMA INVOICE';
  return invoice.documentType === 'utility_invoice' ? 'UTILITY INVOICE' : 'TAX INVOICE';
}

/* ----------------------------------------------------------------- headers */

function drawClassicHeader(
  page: PdfPage, invoice: InvoiceDocument, brand: Brand, name: string,
): number {
  const marked = drawMark(page, brand, name, MARGIN, MARGIN, 16, brand.colour);
  page.text(documentTitle(invoice), PAGE_WIDTH - MARGIN, MARGIN + 2, {
    align: 'right', width: 0, font: 'Helvetica-Bold', size: 12, colour: MUTED,
  });

  let y = MARGIN + marked + 8;
  if (brand.image) {
    page.text(name, MARGIN, y, { size: 9, font: 'Helvetica-Bold', colour: INK });
    y += 11;
  }
  for (const line of landlordLines(invoice)) {
    page.text(truncate(line, 70), MARGIN, y, { size: 8, colour: MUTED });
    y += 10;
  }

  // The three facts a reader looks for first, on the right, against the mark.
  const right = PAGE_WIDTH - MARGIN - 170;
  let ry = MARGIN + 24;
  for (const [label, value] of factPairs(invoice)) {
    page.text(label, right, ry, { size: 7.5, colour: MUTED });
    page.text(value, PAGE_WIDTH - MARGIN, ry, {
      align: 'right', width: 0, size: 9.5, font: 'Helvetica-Bold', colour: INK,
    });
    ry += 15;
  }

  y = Math.max(y, ry) + 6;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { colour: RULE, width: 1 });
  return y + 14;
}

function drawModernHeader(
  page: PdfPage, invoice: InvoiceDocument, brand: Brand, name: string,
): number {
  // A band in the landlord's own colour, with their mark reversed out of it.
  const bandHeight = 92;
  page.rect(0, 0, PAGE_WIDTH, bandHeight, { fill: brand.colour });

  if (brand.image) {
    // A logo keeps its own colours, so it sits on a white plate rather than
    // being dropped onto the band, where a dark mark would disappear.
    const pad = 6;
    page.rect(MARGIN - pad, 26 - pad, brand.width + pad * 2, brand.height + pad * 2, { fill: 1 });
    page.image(brand.image, MARGIN, 26, brand.width, brand.height);
  } else {
    page.text(truncate(name, 34), MARGIN, 34, {
      font: 'Helvetica-Bold', size: 19, colour: 1,
    });
  }

  page.text(documentTitle(invoice), PAGE_WIDTH - MARGIN, 30, {
    align: 'right', width: 0, font: 'Helvetica-Bold', size: 13, colour: 1,
  });
  page.text(`No. ${invoice.documentNumber}`, PAGE_WIDTH - MARGIN, 50, {
    align: 'right', width: 0, size: 10, colour: 0.92,
  });
  const period = periodLabel(invoice);
  if (period) {
    page.text(period, PAGE_WIDTH - MARGIN, 66, {
      align: 'right', width: 0, size: 8.5, colour: 0.9,
    });
  }

  let y = bandHeight + 18;
  if (brand.image) {
    page.text(name, MARGIN, y, { size: 9.5, font: 'Helvetica-Bold', colour: INK });
    y += 12;
  }
  for (const line of landlordLines(invoice)) {
    page.text(truncate(line, 70), MARGIN, y, { size: 8, colour: MUTED });
    y += 10;
  }

  const right = PAGE_WIDTH - MARGIN - 170;
  let ry = bandHeight + 18;
  for (const [label, value] of factPairs(invoice).slice(1)) {
    page.text(label, right, ry, { size: 7.5, colour: MUTED });
    page.text(value, PAGE_WIDTH - MARGIN, ry, {
      align: 'right', width: 0, size: 9.5, font: 'Helvetica-Bold', colour: INK,
    });
    ry += 15;
  }
  return Math.max(y, ry) + 16;
}

function drawCompactHeader(
  page: PdfPage, invoice: InvoiceDocument, brand: Brand, name: string,
): number {
  const marked = drawMark(page, brand, name, MARGIN, MARGIN, 12, brand.colour);
  page.text(
    `${documentTitle(invoice)}  ${invoice.documentNumber}`,
    PAGE_WIDTH - MARGIN, MARGIN + 1,
    { align: 'right', width: 0, font: 'Helvetica-Bold', size: 10, colour: INK },
  );

  let y = MARGIN + marked + 6;
  // One line of identity rather than a block: everything still said, in less
  // room. Truncation would drop a registration number, so it wraps instead.
  const identity = [brand.image ? name : null, ...landlordLines(invoice)]
    .filter((part): part is string => Boolean(part));
  for (const line of wrapSegments(identity, 7.5, CONTENT_WIDTH)) {
    page.text(line, MARGIN, y, { size: 7.5, colour: MUTED });
    y += 9;
  }

  y += 4;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { colour: RULE });
  y += 10;

  // The facts on one row, which is what makes this design short.
  let x = MARGIN;
  for (const [label, value] of factPairs(invoice).slice(1)) {
    page.text(label, x, y, { size: 7, colour: MUTED });
    page.text(value, x, y + 10, { size: 9, font: 'Helvetica-Bold', colour: INK });
    x += 130;
  }
  return y + 30;
}

/** Invoice number, dates and period, in the order a reader looks for them. */
function factPairs(invoice: InvoiceDocument): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ['Invoice number', invoice.documentNumber],
    ['Issued', formatDayMonthYear(invoice.issueDate)],
    ['Due', formatDayMonthYear(invoice.dueDate)],
  ];
  const period = periodLabel(invoice);
  if (period) pairs.push(['For the period', period]);
  return pairs;
}

/* ----------------------------------------------------------------- parties */

/** Who is billed, and for which home. */
function drawParties(
  page: PdfPage, invoice: InvoiceDocument, top: number, template: string,
): number {
  const compact = template === 'compact';
  const size = compact ? 8 : 9;
  let y = top;

  page.text('BILLED TO', MARGIN, y, { size: 7, font: 'Helvetica-Bold', colour: MUTED });
  page.text('THE PROPERTY', MARGIN + 250, y, {
    size: 7, font: 'Helvetica-Bold', colour: MUTED,
  });
  y += 12;

  const billed = [
    invoice.residentName,
    ...(invoice.residentEmail ? [invoice.residentEmail] : []),
    `Lease ${invoice.leaseReference}`,
  ];
  const property = [
    `${invoice.propertyName} / ${invoice.unitCode}`,
    ...invoice.propertyAddress,
  ];

  const rows = Math.max(billed.length, property.length);
  for (let i = 0; i < rows; i += 1) {
    const bold = i === 0;
    if (billed[i]) {
      page.text(truncate(billed[i]!, 44), MARGIN, y, {
        size, colour: bold ? INK : MUTED, ...(bold ? { font: 'Helvetica-Bold' as const } : {}),
      });
    }
    if (property[i]) {
      page.text(truncate(property[i]!, 44), MARGIN + 250, y, {
        size, colour: bold ? INK : MUTED, ...(bold ? { font: 'Helvetica-Bold' as const } : {}),
      });
    }
    y += compact ? 11 : 12;
  }
  return y + (compact ? 8 : 14);
}

/* ------------------------------------------------------------------- lines */

function drawLines(
  page: PdfPage, invoice: InvoiceDocument, top: number, template: string, brand: Brand,
  money: (value: bigint) => string, symbol: string,
): number {
  const compact = template === 'compact';
  const amountX = PAGE_WIDTH - MARGIN;
  let y = top;

  if (template === 'modern') {
    page.rect(MARGIN, y - 5, CONTENT_WIDTH, 20, { fill: brand.tint });
  } else {
    page.rect(MARGIN, y - 5, CONTENT_WIDTH, compact ? 16 : 18, { fill: 0.94 });
  }
  page.text('DESCRIPTION', MARGIN + 8, y, { size: 7.5, font: 'Helvetica-Bold', colour: MUTED });
  page.text('PERIOD', MARGIN + 290, y, { size: 7.5, font: 'Helvetica-Bold', colour: MUTED });
  page.text('AMOUNT', amountX - 8, y, {
    align: 'right', width: 0, size: 7.5, font: 'Helvetica-Bold', colour: MUTED,
  });
  y += compact ? 20 : 24;

  let sum = 0n;
  for (const line of invoice.lines) {
    sum += line.amountMinor;
    page.text(truncate(line.description, 48), MARGIN + 8, y, {
      size: compact ? 8.5 : 9.5, colour: INK,
    });
    const period = line.servicePeriodStart && line.servicePeriodEnd
      ? `${formatDayMonthYear(line.servicePeriodStart)} – ${formatDayMonthYear(line.servicePeriodEnd)}`
      : '';
    if (period) {
      page.text(period, MARGIN + 290, y, { size: compact ? 7.5 : 8, colour: MUTED });
    }
    page.text(symbol + money(line.amountMinor), amountX - 8, y, {
      align: 'right', width: 0, size: compact ? 8.5 : 9.5, colour: INK,
    });
    y += compact ? 11 : 13;

    // Proration shown as the arithmetic. A tenant who is charged for part of a
    // month is entitled to see the sum rather than a figure to take on trust.
    if (line.proration) {
      page.text(
        `${line.proration.numerator} of ${line.proration.denominator} days `
        + `· full period ${symbol}${money(line.proration.fullPeriodAmountMinor)}`,
        MARGIN + 8, y, { size: 7.5, colour: FAINT },
      );
      y += 10;
    }
    y += compact ? 3 : 6;
    page.line(MARGIN, y - 4, PAGE_WIDTH - MARGIN, y - 4, { colour: 0.92 });
  }

  if (invoice.lines.length === 0) {
    page.text('This invoice has no lines.', MARGIN + 8, y, { size: 9, colour: MUTED });
    y += 16;
  }

  // The posted total is what is owed; the sum is a check on it, not a
  // replacement. They disagree only if something is wrong, and then the
  // document says so rather than quietly showing the prettier number.
  if (sum !== invoice.totalMinor) {
    page.text(
      `The lines above come to ${symbol}${money(sum)}, which differs from the posted `
      + 'total below. Ask your landlord before paying.',
      MARGIN + 8, y + 2, { size: 8, font: 'Helvetica-Bold', colour: [0.54, 0.34, 0] },
    );
    y += 18;
  }
  return y + 6;
}

/* ------------------------------------------------------------------- total */

function drawTotal(
  page: PdfPage, invoice: InvoiceDocument, top: number, template: string, brand: Brand,
  money: (value: bigint) => string, symbol: string,
): number {
  const amount = symbol + money(invoice.totalMinor);
  let y = top;

  if (template === 'modern') {
    const height = 46;
    page.rect(MARGIN, y, CONTENT_WIDTH, height, { fill: brand.tint });
    page.text('AMOUNT DUE', MARGIN + 12, y + 12, {
      size: 8, font: 'Helvetica-Bold', colour: MUTED,
    });
    page.text(`by ${formatDayMonthYear(invoice.dueDate)}`, MARGIN + 12, y + 26, {
      size: 9, colour: INK,
    });
    page.text(amount, PAGE_WIDTH - MARGIN - 12, y + 14, {
      align: 'right', width: 0, font: 'Helvetica-Bold', size: 20, colour: brand.colour,
    });
    y += height + 14;
  } else {
    const height = template === 'compact' ? 26 : 32;
    page.rect(MARGIN, y, CONTENT_WIDTH, height, { fill: 0.96 });
    page.text('Amount due', MARGIN + 10, y + (template === 'compact' ? 8 : 10), {
      font: 'Helvetica-Bold', size: template === 'compact' ? 10 : 11, colour: INK,
    });
    page.text(`by ${formatDayMonthYear(invoice.dueDate)}`,
      MARGIN + 10 + measureText('Amount due', 'Helvetica-Bold', 11) + 10,
      y + (template === 'compact' ? 9 : 11), { size: 8.5, colour: MUTED });
    page.text(amount, PAGE_WIDTH - MARGIN - 10, y + (template === 'compact' ? 8 : 10), {
      align: 'right', width: 0, font: 'Helvetica-Bold', size: template === 'compact' ? 12 : 14,
      colour: INK,
    });
    y += height + 12;
  }

  if (invoice.status === 'draft') {
    page.text(
      'PRO FORMA — this invoice is not posted to the account and is not a demand for payment.',
      MARGIN, y, { size: 8.5, font: 'Helvetica-Bold', colour: [0.54, 0.34, 0] },
    );
    y += 14;
  }
  if (invoice.reversed) {
    page.text(
      'REVERSED — a credit note has cancelled this invoice. Do not pay it.',
      MARGIN, y, { size: 9, font: 'Helvetica-Bold', colour: [0.7, 0.15, 0.15] },
    );
    y += 15;
  }
  return y;
}

/* ------------------------------------------------------------- how to pay */

function drawPaymentInstructions(
  page: PdfPage, invoice: InvoiceDocument, top: number, template: string, brand: Brand,
): number {
  const compact = template === 'compact';
  let y = top;

  page.text('HOW TO PAY', MARGIN, y, { size: 7, font: 'Helvetica-Bold', colour: MUTED });
  y += 13;

  if (invoice.payTo) {
    const details: Array<[string, string]> = [
      ['Bank', invoice.payTo.bankName],
      ['Account holder', truncate(invoice.payTo.accountHolder, 34)],
      ['Account ending', invoice.payTo.accountNumberLast4],
      ...(invoice.payTo.branchCode
        ? [['Branch code', invoice.payTo.branchCode] as [string, string]] : []),
    ];
    for (const [label, value] of details) {
      page.text(label, MARGIN, y, { size: 8, colour: MUTED });
      page.text(value, MARGIN + 92, y, { size: 8.5, colour: INK });
      y += compact ? 11 : 12;
    }
    page.text(
      'The full account number is on your signed lease and in the resident portal. '
      + 'It is deliberately not printed on an emailed document.',
      MARGIN, y + 2, { size: 7.5, colour: FAINT },
    );
    y += 16;
  } else {
    page.text(
      'No verified bank account has been recorded yet. Ask your landlord where to pay '
      + 'rather than using details from an email.',
      MARGIN, y, { size: 8.5, colour: INK },
    );
    y += 16;
  }

  // The reference, given the emphasis it earns: a payment without it is a
  // payment somebody has to go looking for.
  const boxHeight = 34;
  page.rect(MARGIN, y, CONTENT_WIDTH, boxHeight, { fill: brand.tint });
  page.text('USE THIS REFERENCE', MARGIN + 10, y + 9, {
    size: 7.5, font: 'Helvetica-Bold', colour: MUTED,
  });
  page.text(invoice.leaseReference, MARGIN + 10, y + 20, {
    font: 'Helvetica-Bold', size: 12, colour: brand.colour,
  });
  page.text(
    'Quote it exactly, on every payment, so it reaches your account.',
    MARGIN + 190, y + 20, { size: 8, colour: INK },
  );
  return y + boxHeight + 10;
}

/* ------------------------------------------------------------------ footer */

function drawFooter(page: PdfPage, invoice: InvoiceDocument, template: string): void {
  const y = PAGE_HEIGHT - MARGIN - 30;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { colour: RULE });

  page.text(
    `Invoice ${invoice.documentNumber} · lease ${invoice.leaseReference} · `
    + `${invoice.propertyName} / ${invoice.unitCode}`,
    MARGIN, y + 8, { size: 7.5, colour: MUTED },
  );
  // The attribution shares the first line, where there is room for it, rather
  // than crowding the sentence below.
  page.text(`${invoiceTemplateByKey(template).label} · Prepared with Spike PropertyOS`,
    PAGE_WIDTH - MARGIN, y + 8, { align: 'right', width: 0, size: 7, colour: 0.72 });
  // Said on every design: an invoice is a demand at a date, not a balance.
  page.text(
    'This invoice states what was charged on the issue date. Payments already made are '
    + 'shown on your statement, not here.',
    MARGIN, y + 20, { size: 7.5, colour: FAINT },
  );
}

/**
 * A specimen says so on its own face.
 *
 * Low on the page, where every design has finished: a watermark across the
 * middle would sit over the bank details, which is the one block on an invoice
 * that must stay legible even on a sample somebody prints by mistake.
 */
function drawSampleMark(page: PdfPage, brand: Brand): void {
  const top = PAGE_HEIGHT - MARGIN - 150;
  page.rect(MARGIN, top - 10, CONTENT_WIDTH, 56, { fill: brand.tint });
  page.text('SAMPLE — NOT A REAL INVOICE', MARGIN + 12, top + 2, {
    font: 'Helvetica-Bold', size: 18, colour: brand.colour,
  });
  page.text(
    'Made-up figures and an invented tenant, shown so a design can be chosen before '
    + 'anything is issued to anybody.',
    MARGIN + 12, top + 26, { size: 8.5, colour: MUTED },
  );
}

/* ------------------------------------------------------------------- words */

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Wraps a list of facts onto as many lines as they need.
 *
 * It breaks between FACTS, never inside one, because the alternative puts a
 * line break through the middle of a telephone number — which is how somebody
 * dials four digits of it.
 */
function wrapSegments(segments: string[], size: number, width: number): string[] {
  const separator = '  ·  ';
  const lines: string[] = [];
  let line = '';
  for (const segment of segments) {
    const candidate = line ? `${line}${separator}${segment}` : segment;
    if (measureText(candidate, 'Helvetica', size) > width && line) {
      lines.push(line);
      line = segment;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}
