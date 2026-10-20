/**
 * What every invoice design must carry.
 *
 * The designs differ in weight, colour and arrangement, and a landlord picks
 * one by eye. What they must not be able to pick is a layout that lost a fact:
 * a tenant who cannot find the reference pays without one, and somebody then
 * spends an afternoon working out whose money arrived.
 *
 * So each design is rendered and read back. Checking the PDF's own text rather
 * than the renderer's intentions is the point — a block drawn off the page,
 * or drawn twice, or drawn in white, is exactly the fault a unit test on the
 * input data cannot see.
 */
import { describe, it, expect } from 'vitest';
import {
  INVOICE_TEMPLATES, invoiceTemplateByKey, renderInvoicePdf, SAMPLE_INVOICE,
  type InvoiceDocument,
} from '@propertyos/domain';

/**
 * The literal strings a PDF draws, which is what a reader actually sees.
 *
 * The two typographic characters this product uses — the em dash and the
 * ellipsis — are written in WinAnsi, where they are single bytes that are not
 * the Unicode ones. They are mapped back here so a test can say what it means.
 */
function textOf(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  return (raw.match(/\(((?:[^()\\]|\\.)*)\) Tj/g) ?? [])
    .map((match) => match.slice(1, -4).replace(/\\([()\\])/g, '$1'))
    .join('\n')
    .replace(/\u0097/g, '—')
    .replace(/\u0096/g, '–')
    .replace(/\u0085/g, '…')
    .replace(/\u00b7/g, '·');
}

const every = INVOICE_TEMPLATES.map((template) => template.key);

describe('every invoice design', () => {
  it.each(every)('%s carries what a tenant needs to pay it', (template) => {
    const text = textOf(renderInvoicePdf(SAMPLE_INVOICE, { template }));

    // Who is charging, by both names, with the identifiers a tenant may need
    // to check them or to claim the VAT.
    expect(text).toContain('Sample Letting');
    expect(text).toContain('Sample Letting (Pty) Ltd');
    expect(text).toContain('Reg 2019/123456/07');
    expect(text).toContain('VAT 4123456789');

    // Which home, by name, unit and street.
    expect(text).toContain('Example Court / B12');
    expect(text).toContain('123 Example Road');

    // Who owes it, and on what lease.
    expect(text).toContain('A. Sample Tenant');

    // The reference, labelled as the thing to quote. This is the one that
    // costs somebody a day of work when it goes missing.
    expect(text).toContain('USE THIS REFERENCE');
    expect(text).toContain('LSE-SAMPLE');

    // The money and the date it is wanted by, in the reader's date format.
    expect(text).toContain('R10,464.96');
    expect(text).toContain('07/03/2026');
    expect(text).not.toContain('2026-03-07');

    // Every line, with the proration shown as arithmetic rather than asserted.
    expect(text).toContain('Monthly rent');
    expect(text).toContain('20 of 31 days');
    expect(text).toContain('R441.75');

    // The utilities by name — a tenant querying a municipal recovery needs to
    // know which one this is — and the sum behind each.
    expect(text).toContain('Water consumption');
    expect(text).toContain('Sewerage / domestic effluent');
    expect(text).toContain('meter 4312 to 4324');
    expect(text).toContain('12 kl × R32.15');

    // And it never calls itself a tax invoice: no tax is shown, most
    // residential letting is exempt, and the words have a legal meaning.
    expect(text).not.toContain('TAX INVOICE');

    // Where to pay, without the full account number, which is deliberately
    // not on a document that gets emailed.
    expect(text).toContain('Example Bank');
    expect(text).toContain('4321');
    expect(text).toContain('full account number');

    // And the standing qualification: an invoice is not a balance.
    expect(text).toContain('Payments already made are shown on your statement');
  });

  it.each(every)('%s produces a file a reader can open', (template) => {
    const raw = Buffer.from(renderInvoicePdf(SAMPLE_INVOICE, { template })).toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(raw).toContain('/Type /Page');
  });

  it('is a short list of designs that were actually laid out', () => {
    expect(INVOICE_TEMPLATES).toHaveLength(3);
    // An unknown key is a design nobody read, so it is not drawn: the default
    // is, which is the one the product ships with.
    expect(invoiceTemplateByKey('something-else').key).toBe('classic');
    expect(invoiceTemplateByKey(null).key).toBe('classic');
  });
});

describe('what an invoice refuses to pretend', () => {
  const alter = (changes: Partial<InvoiceDocument>): InvoiceDocument =>
    ({ ...SAMPLE_INVOICE, ...changes });

  it('says so when the lines do not add up to the posted total', () => {
    // The posted total is the one that is owed. If the lines disagree,
    // something is wrong and the document says so rather than quietly showing
    // whichever figure looks tidier.
    const text = textOf(renderInvoicePdf(alter({ totalMinor: 999_999n })));
    expect(text).toContain('differs from the posted total');
    expect(text).toContain('R9,999.99');
  });

  it('marks a draft as pro forma rather than as a demand', () => {
    const text = textOf(renderInvoicePdf(alter({ status: 'draft' })));
    expect(text).toContain('PRO FORMA');
    expect(text).toContain('not a demand for payment');
    expect(text).not.toContain('TAX INVOICE');
  });

  it('says plainly when a credit note has cancelled it', () => {
    const text = textOf(renderInvoicePdf(alter({
      reversed: true, creditedMinor: 1_046_496n,
    })));
    expect(text).toContain('CREDITED IN FULL');
    expect(text).toContain('Do not pay it');
  });

  it('warns when only PART of it has been credited back', () => {
    // The dangerous case: the total above is no longer what is owed, and an
    // invoice that stays silent invites payment of the larger number.
    const text = textOf(renderInvoicePdf(alter({ creditedMinor: 38_580n })));
    expect(text).toContain('R385.80 of this invoice has since been credited back');
    expect(text).not.toContain('CREDITED IN FULL');
  });

  it('does not invent banking details it was not given', () => {
    const text = textOf(renderInvoicePdf(alter({ payTo: null })));
    expect(text).toContain('No verified bank account');
    expect(text).toContain('rather than using details from an email');
    // The reference is still there: it is the lease's, not the bank's.
    expect(text).toContain('LSE-SAMPLE');
  });

  it('falls back to the landlord’s name when there is no logo', () => {
    const raw = Buffer.from(renderInvoicePdf(SAMPLE_INVOICE, { template: 'modern' }))
      .toString('latin1');
    expect(raw).not.toContain('/Subtype /Image');
    expect(textOf(renderInvoicePdf(SAMPLE_INVOICE))).toContain('Sample Letting');
  });

  it('marks a sample as a sample, on its face', () => {
    const text = textOf(renderInvoicePdf(SAMPLE_INVOICE, { sample: true }));
    expect(text).toContain('SAMPLE — NOT A REAL INVOICE');
    expect(text).toContain('invented tenant');
  });

  it('leaves a document with no lines readable, and says that too', () => {
    const text = textOf(renderInvoicePdf(alter({ lines: [], totalMinor: 0n })));
    expect(text).toContain('This invoice has no lines.');
  });

  it('keeps a very long landlord name on the page', () => {
    // A trading name nobody thought about is how a header ends up running off
    // the right-hand edge, where it is invisible rather than wrong.
    const long = 'The Extremely Long Property Management And Letting Company Of South Africa';
    const text = textOf(renderInvoicePdf(alter({
      landlord: { ...SAMPLE_INVOICE.landlord, tradingName: long },
    })));
    expect(text).not.toContain(long);
    expect(text).toContain('The Extremely Long Property Management An…');
  });

  it('shows a measured line that does not multiply out, without changing it', () => {
    // The posted amount is what is owed. Where the quantity and rate do not
    // come to it, the document says so — it does not silently prefer either.
    const text = textOf(renderInvoicePdf(alter({
      lines: [{ ...SAMPLE_INVOICE.lines[1]!, amountMinor: 50_000n }],
      totalMinor: 50_000n,
    })));
    expect(text).toContain('comes to R385.80');
    expect(text).toContain('R500.00');
  });

  it('reads a credit note as a credit note, in every design', () => {
    for (const template of every) {
      const text = textOf(renderInvoicePdf(alter({
        documentType: 'credit_note',
        documentNumber: 'CRN-000012',
        totalMinor: -38_580n,
        lines: [{ ...SAMPLE_INVOICE.lines[1]!, amountMinor: -38_580n }],
        corrects: { documentNumber: 'INV-SAMPLE-0042', reason: 'Meter was misread' },
      }), { template }));

      expect(text, template).toContain('CREDIT NOTE');
      // Modern sets its labels in capitals; the other two do not.
      expect(text.toUpperCase()).toContain('AMOUNT CREDITED');
      // The amount a reader sees is positive; the sign is carried by words.
      expect(text).toContain('R385.80');
      // Never a negative in a column headed AMOUNT: the document's own words
      // carry the direction.
      expect(text).not.toContain('R-385.80');
      // No due date at all — there is nothing to pay. (Modern and Compact
      // carry the number in their own header rather than in the fact list,
      // which is why only the absence of a due date is asserted for all three.)
      expect(text).toContain('CRN-000012');
      expect(text).not.toContain('Due');
      // What it undoes, and why.
      expect(text).toContain('INV-SAMPLE-0042');
      expect(text).toContain('Meter was misread');
      // Nothing to pay, so no bank details at all — but still the reference,
      // because the tenant's next payment needs it.
      expect(text).not.toContain('HOW TO PAY');
      expect(text).toContain('Nothing is payable on this credit note');
      expect(text).toContain('LSE-SAMPLE');
    }
  });

  it('never prints a category key at a tenant', () => {
    const text = textOf(renderInvoicePdf(alter({
      lines: [{
        ...SAMPLE_INVOICE.lines[0]!,
        category: 'utility_fixed',
        categoryLabel: 'Utilities',
        description: 'Monthly service charge',
      }],
    })));
    expect(text).toContain('Utilities — Monthly service charge');
    expect(text).not.toContain('utility_fixed');
  });
});
