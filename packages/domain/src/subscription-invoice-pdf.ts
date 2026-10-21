import { PdfDocument, measureText, type PdfPage } from '@propertyos/integrations';
import { formatDayMonthYear } from './dates';
import { formatMinor } from './money';
import type { SubscriptionInvoice } from './subscription-billing';

/**
 * Spike's own invoice, as a PDF.
 *
 * A separate renderer from the landlord's invoice and deliberately so: that
 * one is the landlord's document, carries their logo, their accent and their
 * choice of three designs, and is addressed to a resident. This one is Spike's
 * document, has one plain form, and is addressed to a business.
 *
 * What it must carry, which is the list from section 20(4) of the VAT Act and
 * the reason this renderer exists rather than a screen print:
 *
 *   * the word INVOICE — or TAX INVOICE, but ONLY where there is a VAT
 *     registration number behind it and tax shown on the document. A document
 *     that calls itself a tax invoice is one somebody's accountant will claim
 *     against;
 *   * the supplier's name, address and VAT number where there is one;
 *   * the recipient's name and address, as they were when it was issued;
 *   * a serial number and the date of issue;
 *   * a description, a quantity and a price for each line;
 *   * the net, the tax and the total, separately — or, with no registration,
 *     the total and a plain statement that no tax is charged;
 *   * where to pay it and what to quote, because an invoice whose payment
 *     cannot be matched is how money arrives from nobody.
 *
 * It renders what was read and queries nothing, so the document cannot
 * disagree with the screen, and it recomputes nothing except the sum of the
 * lines — which it draws beside the stored net rather than in place of it.
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = 0.08;
const MUTED = 0.42;
const FAINT = 0.6;
const RULE = 0.85;
const SPIKE: [number, number, number] = [0.42, 0.29, 0.78];

export interface SubscriptionBiller {
  legalName: string | null;
  address: string | null;
  email: string | null;
  vatNumber: string | null;
  bankDetails: string | null;
}

export function renderSubscriptionInvoicePdf(
  invoice: SubscriptionInvoice,
  biller: SubscriptionBiller,
): Uint8Array {
  // Tax is shown only when the invoice itself recorded a registration. Reading
  // today's settings here would let a document change its mind: Spike
  // registering in June must not retitle the invoice sent in March.
  const isTaxInvoice = Boolean(invoice.supplierVatNumber) && invoice.vatMinor > 0;

  const document = new PdfDocument({
    title: `${isTaxInvoice ? 'Tax invoice' : 'Invoice'} ${invoice.invoiceNumber}`,
    author: biller.legalName ?? 'Spike Technologies',
    subject: `${invoice.organisationName} — ${invoice.periodStart} to ${invoice.periodEnd}`,
  });

  const page = document.addPage(PAGE_WIDTH, PAGE_HEIGHT);
  const money = (minor: number) => formatMinor(minor, invoice.currencyCode);
  const symbol = invoice.currencyCode === 'ZAR' ? 'R' : `${invoice.currencyCode} `;

  // Each block returns where it finished, so the next one starts there and a
  // long address or a third line cannot write over what follows it.
  const afterHeader = drawHeader(page, invoice, biller, isTaxInvoice);
  const afterParties = drawParties(page, invoice, biller, afterHeader);
  const afterLines = drawLines(page, invoice, afterParties, money, symbol);
  const afterTotals = drawTotals(page, invoice, afterLines, money, symbol, isTaxInvoice);
  drawPayment(page, invoice, biller, afterTotals);
  drawFooter(page, invoice, isTaxInvoice);

  return document.build();
}

/* ------------------------------------------------------------------ pieces */

function right(page: PdfPage, text: string, rightEdge: number, top: number, options: {
  font?: 'Helvetica' | 'Helvetica-Bold'; size?: number; colour?: number | [number, number, number];
} = {}): void {
  const font = options.font ?? 'Helvetica';
  const size = options.size ?? 9;
  page.text(text, rightEdge - measureText(text, font, size), top, { font, size, colour: options.colour ?? INK });
}

function drawHeader(
  page: PdfPage, invoice: SubscriptionInvoice, biller: SubscriptionBiller, isTaxInvoice: boolean,
): number {
  page.rect(0, 0, PAGE_WIDTH, 4, { fill: SPIKE });

  page.text(biller.legalName ?? 'Spike Technologies', MARGIN, 44, {
    font: 'Helvetica-Bold', size: 15, colour: SPIKE,
  });
  page.text('PropertyOS', MARGIN, 62, { size: 9, colour: MUTED });

  right(page, isTaxInvoice ? 'TAX INVOICE' : 'INVOICE', PAGE_WIDTH - MARGIN, 44, {
    font: 'Helvetica-Bold', size: 15,
  });
  right(page, invoice.invoiceNumber, PAGE_WIDTH - MARGIN, 64, { size: 10, colour: MUTED });

  const y = 92;
  const column = CONTENT_WIDTH / 4;
  const at = (index: number, label: string, value: string) => {
    page.text(label, MARGIN + column * index, y, { size: 7.5, colour: FAINT });
    page.text(value, MARGIN + column * index, y + 11, { size: 9.5, colour: INK });
  };
  at(0, 'ISSUED', formatDayMonthYear(invoice.issueDate));
  at(1, 'DUE', formatDayMonthYear(invoice.dueDate));
  at(2, 'PERIOD', `${formatDayMonthYear(invoice.periodStart)} —`);
  page.text(formatDayMonthYear(invoice.periodEnd), MARGIN + column * 2, y + 22, {
    size: 9.5, colour: INK,
  });
  at(3, 'PLAN', invoice.planName);

  const ruleY = y + 44;
  page.line(MARGIN, ruleY, PAGE_WIDTH - MARGIN, ruleY, { colour: RULE });
  return ruleY + 18;
}

function drawParties(
  page: PdfPage, invoice: SubscriptionInvoice, biller: SubscriptionBiller, top: number,
): number {
  const half = CONTENT_WIDTH / 2;
  let leftY = top;
  let rightY = top;

  page.text('FROM', MARGIN, leftY, { size: 7.5, colour: FAINT });
  leftY += 13;
  for (const line of [
    biller.legalName,
    ...(biller.address ?? '').split('\n').slice(0, 3),
    biller.vatNumber ? `VAT ${biller.vatNumber}` : 'Not registered for VAT',
    biller.email,
  ].filter((l): l is string => Boolean(l && l.trim()))) {
    page.text(line.slice(0, 60), MARGIN, leftY, { size: 9, colour: INK });
    leftY += 12;
  }

  page.text('TO', MARGIN + half, rightY, { size: 7.5, colour: FAINT });
  rightY += 13;
  // The name on the invoice is the registered name captured at issue, falling
  // back to the organisation's own name. The address is only printed if it was
  // recorded: an invoice that invents an address is worse than one that admits
  // it does not have it.
  const toLines = [
    invoice.recipientName ?? invoice.organisationName,
    ...(invoice.recipientAddress ?? '').split('\n').slice(0, 3),
    invoice.recipientVatNumber ? `VAT ${invoice.recipientVatNumber}` : null,
  ].filter((l): l is string => Boolean(l && l.trim()));
  for (const line of toLines) {
    page.text(line.slice(0, 60), MARGIN + half, rightY, { size: 9, colour: INK });
    rightY += 12;
  }
  if (!invoice.recipientAddress) {
    page.text('Address not recorded', MARGIN + half, rightY, { size: 8, colour: FAINT });
    rightY += 12;
  }

  return Math.max(leftY, rightY) + 14;
}

function drawLines(
  page: PdfPage, invoice: SubscriptionInvoice, top: number,
  money: (minor: number) => string, symbol: string,
): number {
  let y = top;
  const amountRight = PAGE_WIDTH - MARGIN;
  const eachRight = amountRight - 86;
  const quantityRight = eachRight - 70;

  page.text('WHAT FOR', MARGIN, y, { size: 7.5, colour: FAINT });
  right(page, 'QUANTITY', quantityRight, y, { size: 7.5, colour: FAINT });
  right(page, `EACH ${symbol.trim()}`, eachRight, y, { size: 7.5, colour: FAINT });
  right(page, `AMOUNT ${symbol.trim()}`, amountRight, y, { size: 7.5, colour: FAINT });
  y += 12;
  page.line(MARGIN, y, PAGE_WIDTH - MARGIN, y, { colour: RULE });
  y += 14;

  for (const line of invoice.lines) {
    const description = line.description.length > 72
      ? `${line.description.slice(0, 71)}…`
      : line.description;
    page.text(description, MARGIN, y, { size: 9.5, colour: INK });
    right(page, String(line.quantity), quantityRight, y, { size: 9.5 });
    right(page, money(line.unitPriceMinor), eachRight, y, { size: 9.5 });
    right(page, money(line.amountMinor), amountRight, y, { size: 9.5 });
    y += 16;
  }

  // The usage the overage was worked out from, so the number can be checked
  // rather than taken on trust.
  page.text(
    `${invoice.billableUnits} unit${invoice.billableUnits === 1 ? '' : 's'} in the portfolio, `
      + `${invoice.includedUnits} included in the plan`
      + (invoice.unitsOver > 0 ? `, ${invoice.unitsOver} charged above it` : ''),
    MARGIN, y, { size: 8, colour: FAINT },
  );
  return y + 18;
}

function drawTotals(
  page: PdfPage, invoice: SubscriptionInvoice, top: number,
  money: (minor: number) => string, symbol: string, isTaxInvoice: boolean,
): number {
  let y = top;
  const amountRight = PAGE_WIDTH - MARGIN;
  const labelRight = amountRight - 110;

  page.line(labelRight - 110, y, amountRight, y, { colour: RULE });
  y += 14;

  right(page, 'Net', labelRight, y, { size: 9.5, colour: MUTED });
  right(page, money(invoice.subtotalMinor), amountRight, y, { size: 9.5 });
  y += 15;

  right(
    page,
    isTaxInvoice ? `VAT at ${(invoice.vatRateBp / 100).toFixed(0)}%` : 'VAT — none charged',
    labelRight, y, { size: 9.5, colour: MUTED },
  );
  right(page, money(invoice.vatMinor), amountRight, y, { size: 9.5 });
  y += 8;

  page.line(labelRight - 110, y + 6, amountRight, y + 6, { colour: RULE });
  y += 20;
  right(page, 'Total', labelRight, y, { font: 'Helvetica-Bold', size: 11 });
  right(page, `${symbol}${money(invoice.totalMinor)}`, amountRight, y, {
    font: 'Helvetica-Bold', size: 12,
  });
  y += 20;

  if (!isTaxInvoice) {
    page.text(
      'No VAT is charged on this invoice and no input tax may be deducted against it.',
      MARGIN, y, { size: 8, colour: FAINT },
    );
    y += 14;
  }

  if (invoice.status === 'paid') {
    page.text(
      `Paid${invoice.paidOn ? ` ${formatDayMonthYear(invoice.paidOn)}` : ''}`
        + `${invoice.paymentReference ? ` · ${invoice.paymentReference}` : ''}`
        + ' — nothing is owing on this invoice.',
      MARGIN, y, { size: 9, colour: INK },
    );
    y += 16;
  } else if (invoice.status === 'void') {
    page.text(
      `Withdrawn — ${invoice.voidReason ?? 'this invoice has been voided'}. Nothing is owing.`,
      MARGIN, y, { size: 9, colour: INK },
    );
    y += 16;
  } else if (invoice.paidMinor) {
    page.text(
      `${symbol}${money(invoice.paidMinor)} received so far; `
        + `${symbol}${money(invoice.totalMinor - invoice.paidMinor)} still owing.`,
      MARGIN, y, { size: 9, colour: INK },
    );
    y += 16;
  }

  return y + 6;
}

function drawPayment(
  page: PdfPage, invoice: SubscriptionInvoice, biller: SubscriptionBiller, top: number,
): number {
  let y = top + 4;
  page.text('HOW TO PAY', MARGIN, y, { size: 7.5, colour: FAINT });
  y += 14;

  if (biller.bankDetails?.trim()) {
    for (const line of biller.bankDetails.split('\n').slice(0, 4)) {
      page.text(line.slice(0, 80), MARGIN, y, { size: 9.5, colour: INK });
      y += 13;
    }
  } else {
    page.text('Bank details are not recorded — ask Spike for them.', MARGIN, y, {
      size: 9.5, colour: INK,
    });
    y += 13;
  }

  // The reference matters more than it looks: a payment arriving without one
  // is a payment somebody has to identify by hand.
  page.text('Quote', MARGIN, y + 4, { size: 8, colour: FAINT });
  page.text(invoice.invoiceNumber, MARGIN + 32, y + 4, {
    font: 'Helvetica-Bold', size: 9.5, colour: INK,
  });
  page.text('as the reference.', MARGIN + 32 + measureText(invoice.invoiceNumber, 'Helvetica-Bold', 9.5) + 5,
    y + 4, { size: 8, colour: FAINT });

  return y + 22;
}

function drawFooter(page: PdfPage, invoice: SubscriptionInvoice, isTaxInvoice: boolean): void {
  const y = PAGE_HEIGHT - 42;
  page.line(MARGIN, y - 12, PAGE_WIDTH - MARGIN, y - 12, { colour: RULE });
  page.text(
    `${isTaxInvoice ? 'Tax invoice' : 'Invoice'} ${invoice.invoiceNumber}`
      + ` · ${invoice.organisationName}`
      + ` · ${formatDayMonthYear(invoice.periodStart)} to ${formatDayMonthYear(invoice.periodEnd)}`,
    MARGIN, y, { size: 7, colour: FAINT },
  );
  right(page, 'Spike PropertyOS', PAGE_WIDTH - MARGIN, y, { size: 7, colour: FAINT });
}
