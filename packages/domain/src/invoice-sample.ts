import type { InvoiceDocument } from './invoice-document';

/**
 * A made-up invoice, for choosing a design.
 *
 * An administrator picking a layout needs to see one, and showing them a real
 * tenant's invoice to do it would be using somebody's debt as a swatch. So the
 * preview is this: invented names, an invented address, invented figures, and
 * a reference that is obviously not a lease. Every renderer that draws it is
 * handed `sample: true` as well, which prints SAMPLE across the page — a
 * specimen that can be mistaken for a demand is worse than no specimen.
 *
 * It exercises the parts of a design that are easy to get wrong: several
 * lines rather than one, a prorated line that has to show its arithmetic, and
 * a landlord with every identifier filled in, which is the widest the header
 * ever gets.
 */
export const SAMPLE_INVOICE: InvoiceDocument = {
  documentId: '00000000-0000-0000-0000-000000000000',
  documentNumber: 'INV-SAMPLE-0042',
  documentType: 'rent_invoice',
  status: 'posted',
  issueDate: '2026-03-01',
  dueDate: '2026-03-07',
  periodStart: '2026-03-01',
  periodEnd: '2026-03-31',
  currencyCode: 'ZAR',
  totalMinor: 1_046_496n,
  lines: [
    {
      lineNumber: 1,
      category: 'rent',
      categoryLabel: 'Rent',
      description: 'Monthly rent',
      amountMinor: 900_000n,
      servicePeriodStart: '2026-03-01',
      servicePeriodEnd: '2026-03-31',
      proration: null,
      measurement: null,
    },
    {
      lineNumber: 2,
      category: 'utility_water',
      categoryLabel: 'Water',
      description: 'Water consumption',
      amountMinor: 38_580n,
      servicePeriodStart: '2026-02-01',
      servicePeriodEnd: '2026-02-28',
      proration: null,
      // The sum a tenant checks against their municipal account.
      measurement: {
        quantity: 12,
        unit: 'kl',
        unitRateMinor: 3_215n,
        meterPrevious: 4312,
        meterCurrent: 4324,
      },
    },
    {
      lineNumber: 3,
      category: 'utility_sewerage',
      categoryLabel: 'Sewerage (domestic effluent)',
      description: 'Sewerage / domestic effluent',
      amountMinor: 79_416n,
      servicePeriodStart: '2026-02-01',
      servicePeriodEnd: '2026-02-28',
      proration: null,
      measurement: {
        quantity: 12, unit: 'kl', unitRateMinor: 6_618n,
        meterPrevious: null, meterCurrent: null,
      },
    },
    {
      lineNumber: 4,
      category: 'parking',
      categoryLabel: 'Parking',
      description: 'Parking bay 14 (part month)',
      amountMinor: 28_500n,
      servicePeriodStart: '2026-03-12',
      servicePeriodEnd: '2026-03-31',
      proration: { numerator: 20, denominator: 31, fullPeriodAmountMinor: 44_175n },
      measurement: null,
    },
  ],
  leaseReference: 'LSE-SAMPLE',
  propertyName: 'Example Court',
  unitCode: 'B12',
  propertyAddress: ['123 Example Road', 'Sampleville, Cape Town', 'Western Cape 8001'],
  residentName: 'A. Sample Tenant',
  residentEmail: 'tenant@example.invalid',
  landlord: {
    legalName: 'Sample Letting (Pty) Ltd',
    tradingName: 'Sample Letting',
    registrationNumber: '2019/123456/07',
    vatNumber: '4123456789',
    physicalAddress: '5 Specimen Street\nSampleville, Cape Town',
    phone: '021 000 0000',
    email: 'accounts@example.invalid',
    agentName: 'Sample Property Practitioners',
    agentContact: '021 000 0001',
  },
  payTo: {
    bankName: 'Example Bank',
    accountHolder: 'Sample Letting (Pty) Ltd',
    accountNumberLast4: '4321',
    branchCode: '250655',
  },
  creditedMinor: 0n,
  reversed: false,
  corrects: null,
};
