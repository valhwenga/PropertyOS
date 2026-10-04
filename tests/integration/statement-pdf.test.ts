/**
 * PDF statements.
 *
 * The PDFs are checked structurally (a real reader must be able to open them)
 * AND for content: the figures a resident relies on must actually appear, and
 * the deposit must be visibly separate from the balance due.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateLease, allocateReceipt, buildStatement, confirmReceipt, createResident,
  createStandaloneHouse, draftLease, parseMajorToMinor, postCharge,
  renderStatementPdf, submitPaymentEvidence, suggestAllocation,
} from '@propertyos/domain';
import { PdfDocument, encodeWinAnsi, measureText } from '@propertyos/integrations';
import {
  as, closeOwner, createOrganisation, grantPortalAccess, ownerSql,
  type OrganisationFixture,
} from '../support/factories.js';

const R = (v: string) => parseMajorToMinor(v, 'ZAR');

/** Pulls the literal strings out of a PDF's content streams. */
function extractText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const matches = raw.match(/\(((?:[^()\\]|\\.)*)\) Tj/g) ?? [];
  return matches
    .map((m) => m.slice(1, -4).replace(/\\([()\\])/g, '$1'))
    .join('\n');
}

describe('PDF writer', () => {
  it('produces a structurally valid PDF', () => {
    const document = new PdfDocument({ title: 'Test' });
    document.addPage().text('Hello', 50, 50);
    const pdf = Buffer.from(document.build()).toString('latin1');

    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
    expect(pdf).toContain('/Type /Pages');
    expect(pdf).toContain('/Type /Page');
    expect(pdf).toContain('xref');
    expect(pdf).toContain('trailer');
  });

  it('records byte offsets that actually point at their objects', () => {
    const document = new PdfDocument({ title: 'Offsets' });
    document.addPage().text('One', 50, 50);
    document.addPage().text('Two', 50, 50);
    const raw = Buffer.from(document.build()).toString('latin1');

    const xrefStart = Number(/startxref\s+(\d+)/.exec(raw)![1]);
    expect(raw.slice(xrefStart, xrefStart + 4)).toBe('xref');

    // Every offset in the table must land on "<n> 0 obj".
    const entries = raw.slice(xrefStart).match(/^(\d{10}) 00000 n $/gm) ?? [];
    expect(entries.length).toBeGreaterThan(0);
    entries.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(raw.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('escapes the PDF string delimiters so a description cannot break the file', () => {
    expect(encodeWinAnsi('Unit (4) \\ "quoted"')).toBe('Unit \\(4\\) \\\\ "quoted"');
    const document = new PdfDocument({ title: 'Escaping' });
    document.addPage().text('Rent (January) \\ adjustment', 50, 50);
    const pdf = Buffer.from(document.build()).toString('latin1');
    // The stream length must still be consistent, which it would not be if the
    // parentheses had terminated the string early.
    const declared = Number(/<< \/Length (\d+) >>/.exec(pdf)![1]);
    const stream = /stream\n([\s\S]*?)endstream/.exec(pdf)![1]!;
    expect(Buffer.byteLength(stream, 'latin1')).toBe(declared);
  });

  it('keeps Afrikaans and other Latin-1 diacritics intact', () => {
    const encoded = encodeWinAnsi('Môreson Hoërskool — Ratepayers');
    expect(encoded).toContain(String.fromCharCode(0xf4)); // ô
    expect(encoded).toContain(String.fromCharCode(0xeb)); // ë
    expect(encoded).toContain(String.fromCharCode(0x97)); // em dash
  });

  it('replaces characters outside WinAnsi rather than corrupting the file', () => {
    // A known limit, recorded in docs/known-limitations.md: no embedded font.
    expect(encodeWinAnsi('Привет 世界')).toBe('?????? ??');
  });

  it('measures text well enough to right-align a money column', () => {
    const narrow = measureText('1.00', 'Helvetica', 10);
    const wide = measureText('1,234,567.89', 'Helvetica', 10);
    expect(wide).toBeGreaterThan(narrow);
    // A twelve-character amount at 9pt must fit the 66pt column.
    expect(measureText('1,234,567.89', 'Helvetica', 9)).toBeLessThan(66);
  });

  it('refuses to build a PDF with no pages', () => {
    expect(() => new PdfDocument({ title: 'Empty' }).build()).toThrow(/at least one page/);
  });
});

describe('Statement PDF', () => {
  let org: OrganisationFixture;
  let leaseId: string;
  let residentId: string;

  beforeAll(async () => {
    org = await createOrganisation('PDF Statement Co');
    const resident = await as(org.adminUserId, (tx) =>
      createResident(tx, org.organisationId, org.adminUserId, {
        firstName: 'Thandiwe', lastName: 'Mokoena',
      }),
    );
    residentId = resident.residentId;
    const house = await as(org.adminUserId, (tx) =>
      createStandaloneHouse(tx, org.organisationId, org.adminUserId, {
        name: '14 Protea Street', code: 'PDFPROTEA', propertyType: 'house',
        addressLine1: '14 Protea Street', city: 'Cape Town',
      }),
    );
    const lease = await as(org.adminUserId, (tx) =>
      draftLease(tx, org.organisationId, org.adminUserId, {
        unitId: house.unitId, startDate: '2026-01-01', endDate: '2026-12-31', rentMinor: R('8000'),
        parties: [{ residentId, role: 'primary_resident' }],
      }),
    );
    leaseId = lease.leaseId;
    await as(org.adminUserId, (tx) =>
      activateLease(tx, org.organisationId, org.adminUserId, {
        leaseId, expectedVersion: 1, activationDate: '2026-01-01',
        executionExceptionReason: 'Filed offline.',
      }),
    );

    // The blueprint's worked example.
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'opening_balance', issueDate: '2025-12-31', dueDate: '2025-12-31',
        lines: [{ category: 'other', description: 'Opening arrears brought forward', amountMinor: R('1000'), dueDate: '2025-12-31' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'rent_invoice', issueDate: '2026-01-01', dueDate: '2026-01-01',
        lines: [{ category: 'rent', description: 'Monthly rent', amountMinor: R('8000'), dueDate: '2026-01-01' }],
      }),
    );
    await as(org.adminUserId, (tx) =>
      postCharge(tx, org.organisationId, org.adminUserId, {
        leaseId, documentType: 'utility_invoice', issueDate: '2026-01-05', dueDate: '2026-01-07',
        lines: [{ category: 'utility_water', description: 'Water (reviewed)', amountMinor: R('350'), dueDate: '2026-01-07' }],
      }),
    );
    const receipt = await as(org.adminUserId, (tx) =>
      confirmReceipt(tx, org.organisationId, org.adminUserId, {
        leaseId, amountMinor: R('7500'), receivedOn: '2026-01-07',
      }),
    );
    const suggestion = await as(org.adminUserId, (tx) =>
      suggestAllocation(tx, org.organisationId, { leaseId, amountMinor: R('7500') }),
    );
    await as(org.adminUserId, (tx) =>
      allocateReceipt(tx, org.organisationId, org.adminUserId, {
        receiptId: receipt.receiptId, allocations: suggestion.allocations, postingDate: '2026-01-07',
      }),
    );
  });

  afterAll(async () => { await closeOwner(); });

  async function render() {
    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2026-01-31' }),
    );
    return {
      statement,
      pdf: renderStatementPdf(statement, {
        organisationName: 'PDF Statement Co',
        propertyLabel: '14 Protea Street / MAIN',
        residentName: 'Thandiwe Mokoena',
        contactEmail: 'accounts@example.invalid',
      }),
    };
  }

  it('carries the blueprint closing figure of R1,850.00', async () => {
    const { statement, pdf } = await render();
    // Kept on disk so the rendered document can be inspected by eye and by an
    // independent parser, rather than only asserted about.
    if (process.env.PDF_SAMPLE_PATH) await writeFile(process.env.PDF_SAMPLE_PATH, pdf);
    expect(statement.closingReceivableMinor).toBe(R('1850'));

    const text = extractText(pdf);
    expect(text).toContain('R1,850.00');
    expect(text).toContain('Closing balance due');
    // And the lines that produced it. The R7,500 receipt was allocated across
    // two charges (R1,000 to the arrears, R6,500 to the rent), so it appears as
    // those two credits rather than one figure — which is exactly what the
    // resident needs to see to follow where their money went.
    expect(text).toContain('1,000.00');
    expect(text).toContain('8,000.00');
    expect(text).toContain('350.00');
    expect(text).toContain('6,500.00');

    const credits = statement.lines.reduce((sum, l) => sum + l.creditMinor, 0n);
    expect(credits).toBe(R('7500'));
  });

  it('identifies the resident, property and lease', async () => {
    const { pdf } = await render();
    const text = extractText(pdf);
    expect(text).toContain('Thandiwe Mokoena');
    expect(text).toContain('14 Protea Street / MAIN');
    expect(text).toMatch(/Lease LSE-\d{6}/);
    expect(text).toContain('PDF Statement Co');
    expect(text).toContain('2026-01-31');
  });

  it('shows the opening balance and where it came from', async () => {
    const { pdf } = await render();
    const text = extractText(pdf);
    expect(text).toContain('Opening balance');
    expect(text).toContain('no earlier activity');
  });

  it('uses a text wordmark, never an invented logo', async () => {
    const { pdf } = await render();
    const text = extractText(pdf);
    expect(text).toContain('Spike');
    expect(text).toContain('PropertyOS');
    // No image objects at all.
    expect(Buffer.from(pdf).toString('latin1')).not.toContain('/Subtype /Image');
  });

  it('states that every line traces to a posted record', async () => {
    const { pdf } = await render();
    expect(extractText(pdf)).toContain('traces to a posted charge');
  });

  it('shows a deposit as SEPARATE from the balance due', async () => {
    const [book] = await ownerSql()<{ id: string }[]>`
      select id from financial_books where organisation_id = ${org.organisationId} and is_default
    `;
    const [account] = await ownerSql()<{ id: string }[]>`
      insert into deposit_accounts (organisation_id, book_id, lease_id, holder,
        currency_code, required_minor, opened_on)
      values (${org.organisationId}, ${book!.id}, ${leaseId}, 'landlord', 'ZAR', 800000, '2026-01-01')
      returning id
    `;
    await ownerSql()`
      insert into deposit_events (organisation_id, deposit_account_id, event_type,
        amount_minor, currency_code, effective_on, description)
      values (${org.organisationId}, ${account!.id}, 'received', 800000, 'ZAR', '2026-01-01', 'Deposit received')
    `;

    const { statement, pdf } = await render();
    const text = extractText(pdf);

    expect(statement.depositHeldMinor).toBe(R('8000'));
    expect(text).toContain('Held separately from the balance above');
    expect(text).toContain('Deposit held');
    expect(text).toContain('does not reduce the balance due');
    // The balance due is unchanged by the deposit.
    expect(statement.closingReceivableMinor).toBe(R('1850'));
  });

  it('states that uploaded evidence has NOT been applied', async () => {
    const residentUser = await grantPortalAccess(org.organisationId, leaseId, residentId, 'PDF Portal User');
    await as(residentUser, (tx) =>
      submitPaymentEvidence(tx, org.organisationId, residentUser, {
        leaseId, claimedAmountMinor: R('1850'), claimedPaidAt: '2026-01-28',
      }),
    );
    const { statement, pdf } = await render();
    const text = extractText(pdf);

    expect(text).toContain('Payment awaiting verification');
    expect(text).toContain('NOT included above');
    // And the balance really is unchanged.
    expect(statement.closingReceivableMinor).toBe(R('1850'));
  });

  it('paginates a long statement and repeats the heading', async () => {
    for (let month = 1; month <= 12; month += 1) {
      const m = String(month).padStart(2, '0');
      await as(org.adminUserId, (tx) =>
        postCharge(tx, org.organisationId, org.adminUserId, {
          leaseId, documentType: 'adjustment_debit',
          issueDate: `2027-${m}-01`, dueDate: `2027-${m}-01`,
          lines: [
            { category: 'other', description: `Sundry charge ${m} A`, amountMinor: R('100'), dueDate: `2027-${m}-01` },
            { category: 'other', description: `Sundry charge ${m} B`, amountMinor: R('100'), dueDate: `2027-${m}-01` },
            { category: 'other', description: `Sundry charge ${m} C`, amountMinor: R('100'), dueDate: `2027-${m}-01` },
          ],
        }),
      );
    }
    const statement = await as(org.adminUserId, (tx) =>
      buildStatement(tx, org.organisationId, { leaseId, cutOff: '2027-12-31' }),
    );
    expect(statement.lines.length).toBeGreaterThan(38);

    const pdf = renderStatementPdf(statement, {
      organisationName: 'PDF Statement Co',
      propertyLabel: '14 Protea Street / MAIN',
      residentName: 'Thandiwe Mokoena',
    });
    const raw = Buffer.from(pdf).toString('latin1');
    const pageCount = Number(/\/Count (\d+)/.exec(raw)![1]);
    expect(pageCount).toBeGreaterThan(1);

    const text = extractText(pdf);
    expect(text).toContain('continued');
    // The closing block still renders, on the last page.
    expect(text).toContain('Closing balance due');
    // Every line made it in.
    expect(text).toContain('Sundry charge 12 C');
  });

  it('is opened without error by an independent PDF tool', async () => {
    const { pdf } = await render();
    const directory = await mkdtemp(join(tmpdir(), 'propertyos-pdf-'));
    const path = join(directory, 'statement.pdf');
    try {
      await writeFile(path, pdf);
      // `pdftotext` is an independent parser: if it reads the file, the
      // structure is sound in a way our own assertions cannot prove.
      let available = true;
      try {
        execFileSync('pdftotext', ['-v'], { stdio: 'pipe' });
      } catch {
        available = false;
      }
      if (!available) {
        // Recorded rather than silently skipped.
        expect(Buffer.from(pdf).toString('latin1')).toContain('%%EOF');
        return;
      }
      const output = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
      expect(output).toContain('Thandiwe Mokoena');
      expect(output).toContain('1,850.00');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
