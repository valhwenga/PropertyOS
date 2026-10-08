/**
 * How a merged agreement is laid out.
 *
 * Two things are being pinned. First, every value this lease supplied — the
 * names, the identity and account numbers, the address, the amounts and the
 * dates — is marked so the PDF can set it in bold, and the marks never escape
 * into anything that is stored or displayed. Second, the reflow that turns a
 * template's hard-wrapped clauses into paragraphs leaves the signature block
 * exactly as its author typed it, because the dotted lines people sign on are
 * only lines if they stay on separate lines.
 */
import { describe, expect, it } from 'vitest';
import {
  VALUE_MARK_END, VALUE_MARK_START, reflow, renderTemplate, stripValueMarks,
} from '@propertyos/domain';
import { measureText } from '@propertyos/integrations';

const mark = (v: string): string => `${VALUE_MARK_START}${v}${VALUE_MARK_END}`;

describe('marking merged values', () => {
  it('marks a filled value and leaves the template wording alone', () => {
    const r = renderTemplate(
      'The Tenant is {{tenant.primary_name}}.',
      { 'tenant.primary_name': 'Thandiwe Mokoena' },
      { markValues: true },
    );
    expect(r.text).toBe(`The Tenant is ${mark('Thandiwe Mokoena')}.`);
    expect(stripValueMarks(r.text)).toBe('The Tenant is Thandiwe Mokoena.');
  });

  it('marks a value that could not be filled, which is the one to look at', () => {
    const r = renderTemplate('Rent {{money.rent}}.', {}, { markValues: true });
    expect(r.text).toBe(`Rent ${mark('[money.rent]')}.`);
    expect(r.missing).toEqual(['money.rent']);
  });

  it('marks nothing unless asked, so stored text and previews stay plain', () => {
    const r = renderTemplate(
      'The Tenant is {{tenant.primary_name}}.',
      { 'tenant.primary_name': 'Thandiwe Mokoena' },
    );
    expect(r.text).toBe('The Tenant is Thandiwe Mokoena.');
    expect(r.text).not.toContain(VALUE_MARK_START);
  });

  it('strips marks a template tried to supply, so emphasis cannot be forged', () => {
    // Otherwise a template author could bold their own wording and have it read
    // as a value this lease provided.
    const r = renderTemplate(
      `The Landlord ${mark('may enter at any time')} and {{landlord.name}}.`,
      { 'landlord.name': 'Blue Crane Rentals' },
      { markValues: true },
    );
    expect(r.text).toBe(
      `The Landlord may enter at any time and ${mark('Blue Crane Rentals')}.`,
    );
  });

  it('leaves text without marks untouched', () => {
    expect(stripValueMarks('nothing to strip')).toBe('nothing to strip');
  });
});

describe('Helvetica-Bold metrics', () => {
  /**
   * Bold used to be approximated as regular x 1.06. That is wrong in both
   * directions, and once bold values sat inside regular sentences the error
   * showed as a gap before the next word — "Thandiwe Mokoena ." — because the
   * renderer advances the cursor by the measured width of each run.
   */
  it('measures a bold digit exactly as wide as a regular one', () => {
    expect(measureText('0123456789', 'Helvetica-Bold', 10))
      .toBeCloseTo(measureText('0123456789', 'Helvetica', 10), 6);
  });

  it('measures a bold letter wider than a regular one', () => {
    expect(measureText('iiii', 'Helvetica-Bold', 10))
      .toBeGreaterThan(measureText('iiii', 'Helvetica', 10));
  });
});

describe('reflow', () => {
  it('folds an indented continuation back into its clause', () => {
    expect(reflow([
      '1.3 All tenants signing this agreement are everyone named above. Where more',
      '    than one person signs, each of them is liable for the whole.',
    ].join('\n'))).toEqual([
      '1.3 All tenants signing this agreement are everyone named above. '
        + 'Where more than one person signs, each of them is liable for the whole.',
    ]);
  });

  it('keeps a label column as its own row', () => {
    // Two or more spaces are a column separator, not a wrapped sentence.
    const lines = reflow('1.1 The Landlord\n    Name                Blue Crane\n    Email               a@b.c');
    expect(lines).toHaveLength(3);
  });

  it('leaves the signature block exactly as typed', () => {
    // Nothing here is indented, so nothing here folds. If it ever did, the
    // dotted lines people sign on would run into one another.
    const block = [
      'Landlord: ............................................',
      'Blue Crane Rentals',
      'Date: ..................  Place: ..................',
      '',
      'Witness 1: ...........................................',
      'Witness 2: ...........................................',
    ].join('\n');
    expect(reflow(block)).toEqual(block.split('\n'));
  });

  it('does not fold a line into a blank line or a heading', () => {
    expect(reflow('SUBLETTING\n    some indented text')).toEqual([
      'SUBLETTING', '    some indented text',
    ]);
  });
});

/**
 * The deposit refund account is the tenant's. Nothing may put the whole number
 * on a page, and the catalogue is where that is decided.
 */
describe('sensitive merge fields', () => {
  it('marks every account and identity number sensitive', async () => {
    const { LEASE_MERGE_FIELDS } = await import('@propertyos/domain');
    const shouldBeSensitive = [
      'bank.account_number',
      'refund.account_number',
      'landlord.identity_number',
      'tenant.primary_identity_number',
      'tenant.identity_numbers',
    ];
    for (const key of shouldBeSensitive) {
      const field = LEASE_MERGE_FIELDS.find((f) => f.key === key);
      expect(field, `${key} is missing from the catalogue`).toBeDefined();
      expect(field!.sensitive, `${key} must be redacted in the stored snapshot`).toBe(true);
    }
  });
});
