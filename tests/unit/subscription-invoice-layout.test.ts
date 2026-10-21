/**
 * What Spike's own invoice must carry.
 *
 * Read back out of the rendered PDF rather than asserted on the input, because
 * the faults that matter here are invisible to a test on the data: a block
 * drawn off the page, drawn twice, or drawn over the one below it still has
 * perfect inputs. The document is also the one place where getting VAT wrong
 * costs somebody money with SARS, so the heading and the tax line are checked
 * in both states.
 */
import { describe, it, expect } from 'vitest';
import {
  renderSubscriptionInvoicePdf, type SubscriptionInvoice,
} from '@propertyos/domain';

function textOf(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  return (raw.match(/\(((?:[^()\\]|\\.)*)\) Tj/g) ?? [])
    .map((match) => match.slice(1, -4).replace(/\\([()\\])/g, '$1'))
    .join('\n')
    .replace(/\u0097/g, '—')
    .replace(/\u0096/g, '–')
    .replace(/\u0085/g, '…')
    .replace(/·/g, '·');
}

const BILLER = {
  legalName: 'Spike Technologies (Pty) Ltd',
  address: '1 Example Road\nCape Town\n8001',
  email: 'billing@example.invalid',
  vatNumber: null as string | null,
  bankDetails: 'Example Bank · account 1234567890 · branch 250655',
};

const INVOICE: SubscriptionInvoice = {
  id: '11111111-1111-4111-8111-111111111111',
  organisationId: '22222222-2222-4222-8222-222222222222',
  organisationName: '[DEMO] Blue Crane Rentals',
  invoiceNumber: 'SPK-2026-00007',
  periodStart: '2026-03-01',
  periodEnd: '2026-04-01',
  issueDate: '2026-04-01',
  dueDate: '2026-04-15',
  currencyCode: 'ZAR',
  planKey: 'starter',
  planName: 'Starter',
  includedUnits: 10,
  billableUnits: 12,
  unitsOver: 2,
  subtotalMinor: 32_300,
  vatRateBp: 0,
  vatMinor: 0,
  totalMinor: 32_300,
  supplierVatNumber: null,
  recipientName: 'Blue Crane Rentals (Pty) Ltd',
  recipientAddress: '12 Loop Street\nCape Town\n8001',
  recipientVatNumber: '4123456789',
  status: 'issued',
  paidOn: null,
  paidMinor: null,
  paymentReference: null,
  voidReason: null,
  overdue: false,
  lines: [
    {
      lineNo: 1,
      kind: 'plan',
      description: 'Starter plan — 2026-03-01 to 2026-04-01, 10 units included',
      quantity: 1,
      unitPriceMinor: 29_900,
      amountMinor: 29_900,
    },
    {
      lineNo: 2,
      kind: 'overage',
      description: '2 units above the plan allowance',
      quantity: 2,
      unitPriceMinor: 1_200,
      amountMinor: 2_400,
    },
  ],
};

describe('a subscription invoice', () => {
  const text = textOf(renderSubscriptionInvoicePdf(INVOICE, BILLER));

  it('says who is charging, with their address', () => {
    expect(text).toContain('Spike Technologies (Pty) Ltd');
    expect(text).toContain('1 Example Road');
    expect(text).toContain('Cape Town');
  });

  it('says who is being charged, by registered name and address', () => {
    // The registered name captured at issue, not the display name — this is
    // the document a customer's accountant files.
    expect(text).toContain('Blue Crane Rentals (Pty) Ltd');
    expect(text).toContain('12 Loop Street');
    expect(text).toContain('VAT 4123456789');
  });

  it('carries its number, its dates and the period', () => {
    expect(text).toContain('SPK-2026-00007');
    // The product's own day/month/year form, as every other document uses.
    expect(text).toContain('01/04/2026');     // issued, and due the 15th
    expect(text).toContain('15/04/2026');
    expect(text).toContain('01/03/2026');     // the period billed
  });

  it('shows every line with its quantity and price', () => {
    expect(text).toContain('Starter plan');
    expect(text).toContain('2 units above the plan allowance');
    expect(text).toContain('299.00');
    expect(text).toContain('12.00');
    expect(text).toContain('24.00');
  });

  it('shows the usage the overage was worked out from', () => {
    // So the number can be checked rather than taken on trust.
    expect(text).toContain('12 units in the portfolio');
    expect(text).toContain('10 included in the plan');
    expect(text).toContain('2 charged above it');
  });

  it('adds up, and says what to quote when paying it', () => {
    expect(text).toContain('323.00');
    expect(text).toContain('Example Bank');
    expect(text).toMatch(/Quote[\s\S]*SPK-2026-00007[\s\S]*reference/);
  });
});

describe('the VAT heading', () => {
  it('says INVOICE and charges no tax where there is no registration', () => {
    const text = textOf(renderSubscriptionInvoicePdf(INVOICE, BILLER));
    expect(text).toContain('INVOICE');
    expect(text).not.toContain('TAX INVOICE');
    expect(text).toContain('VAT — none charged');
    expect(text).toContain('Not registered for VAT');
    // The sentence that stops somebody claiming input tax against it.
    expect(text).toContain('No VAT is charged on this invoice');
  });

  it('says TAX INVOICE and shows the tax where the invoice recorded one', () => {
    const text = textOf(renderSubscriptionInvoicePdf(
      {
        ...INVOICE,
        supplierVatNumber: '4000000000',
        vatRateBp: 1500,
        vatMinor: 4_845,
        totalMinor: 37_145,
      },
      { ...BILLER, vatNumber: '4000000000' },
    ));
    expect(text).toContain('TAX INVOICE');
    expect(text).toContain('VAT at 15%');
    expect(text).toContain('VAT 4000000000');
    expect(text).toContain('48.45');
    expect(text).toContain('371.45');
    expect(text).not.toContain('No VAT is charged');
  });

  it('does not call itself a tax invoice on a registration with no tax shown', () => {
    // The pair has to agree. A document headed TAX INVOICE with no tax on it
    // fails section 20(4) either way round, and this is the state a half-done
    // configuration change would produce.
    const text = textOf(renderSubscriptionInvoicePdf(
      { ...INVOICE, supplierVatNumber: '4000000000', vatRateBp: 1500, vatMinor: 0 },
      { ...BILLER, vatNumber: '4000000000' },
    ));
    expect(text).not.toContain('TAX INVOICE');
    expect(text).toContain('VAT — none charged');
  });
});

describe('an invoice that has been settled or withdrawn', () => {
  it('says it is paid, so nobody pays it twice', () => {
    const text = textOf(renderSubscriptionInvoicePdf(
      {
        ...INVOICE, status: 'paid', paidOn: '2026-04-10',
        paymentReference: 'EFT 20260410', paidMinor: 32_300,
      },
      BILLER,
    ));
    expect(text).toContain('Paid 10/04/2026');
    expect(text).toContain('EFT 20260410');
    expect(text).toContain('nothing is owing');
  });

  it('says it is withdrawn, with the reason', () => {
    const text = textOf(renderSubscriptionInvoicePdf(
      { ...INVOICE, status: 'void', voidReason: 'billed on the wrong plan' },
      BILLER,
    ));
    expect(text).toContain('Withdrawn');
    expect(text).toContain('billed on the wrong plan');
  });

  it('says what is still owing on a short payment', () => {
    const text = textOf(renderSubscriptionInvoicePdf(
      { ...INVOICE, paidMinor: 20_000 },
      BILLER,
    ));
    expect(text).toContain('200.00 received so far');
    expect(text).toContain('123.00 still owing');
  });
});

describe('an invoice to a customer who has not recorded their particulars', () => {
  it('falls back to the organisation name and admits the address is missing', () => {
    const text = textOf(renderSubscriptionInvoicePdf(
      { ...INVOICE, recipientName: null, recipientAddress: null, recipientVatNumber: null },
      BILLER,
    ));
    // Inventing an address would be worse than saying there is not one.
    expect(text).toContain('[DEMO] Blue Crane Rentals');
    expect(text).toContain('Address not recorded');
  });

  it('says the bank details are missing rather than printing nothing', () => {
    const text = textOf(renderSubscriptionInvoicePdf(
      INVOICE, { ...BILLER, bankDetails: null },
    ));
    expect(text).toContain('Bank details are not recorded');
  });
});
