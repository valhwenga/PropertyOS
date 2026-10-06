import { describe, expect, it } from 'vitest';
import {
  LEASE_MERGE_FIELDS, formatLeaseDate, renderTemplate, templatePlaceholders,
} from '../../packages/domain/src/lease-agreements';

const values = {
  'tenant.primary_name': 'Anthony Tebogo Maetane',
  'money.rent': 'R7,200.00',
  'term.effective_date': '01 November 2025',
  'property.full_address': 'Unit 40 Antibes, 18 West Road South, Morningside',
};

describe('lease template merging', () => {
  it('substitutes known placeholders', () => {
    const r = renderTemplate(
      'The LESSOR lets to {{tenant.primary_name}} the premises at {{property.full_address}}.',
      values,
    );
    expect(r.text).toBe(
      'The LESSOR lets to Anthony Tebogo Maetane the premises at Unit 40 Antibes, 18 West Road South, Morningside.',
    );
    expect(r.missing).toEqual([]);
    expect(r.unknown).toEqual([]);
  });

  // The rule that matters most: an agreement must never go out with a silently
  // empty rental or deposit.
  it('leaves an unfilled placeholder visible and reports it, rather than blanking it', () => {
    const r = renderTemplate('The rental shall be {{money.rent}} and the deposit {{money.deposit}}.', values);
    expect(r.text).toBe('The rental shall be R7,200.00 and the deposit [money.deposit].');
    expect(r.missing).toEqual(['money.deposit']);
  });

  it('treats a whitespace-only value as missing', () => {
    const r = renderTemplate('Court: {{legal.jurisdiction_court}}.', { 'legal.jurisdiction_court': '   ' });
    expect(r.missing).toEqual(['legal.jurisdiction_court']);
    expect(r.text).toContain('[legal.jurisdiction_court]');
  });

  it('reports a placeholder the catalogue does not define, and leaves it untouched', () => {
    const r = renderTemplate('Hello {{tenant.middle_name}} and {{money.rent}}.', values);
    expect(r.unknown).toEqual(['tenant.middle_name']);
    expect(r.text).toContain('{{tenant.middle_name}}');
    expect(r.text).toContain('R7,200.00');
  });

  it('tolerates spacing inside the braces and is case-insensitive', () => {
    const r = renderTemplate('{{  Money.Rent  }}', values);
    expect(r.text).toBe('R7,200.00');
  });

  it('substitutes every occurrence, not just the first', () => {
    const r = renderTemplate('{{money.rent}} ... {{money.rent}}', values);
    expect(r.text).toBe('R7,200.00 ... R7,200.00');
  });

  // A value containing something that looks like a placeholder must not then be
  // re-scanned, or a tenant could inject fields by naming themselves after one.
  it('does not re-expand a value that itself looks like a placeholder', () => {
    const r = renderTemplate('{{tenant.primary_name}}', { 'tenant.primary_name': '{{money.rent}}', ...values, 'tenant.primary_name': '{{money.rent}}' });
    expect(r.text).toBe('{{money.rent}}');
  });

  it('lists the placeholders a template uses', () => {
    expect(templatePlaceholders('a {{money.rent}} b {{money.rent}} c {{tenant.names}}'))
      .toEqual(['money.rent', 'tenant.names']);
  });

  it('formats dates the way an agreement reads them', () => {
    expect(formatLeaseDate('2025-11-01')).toBe('01 November 2025');
    expect(formatLeaseDate('2026-10-31')).toBe('31 October 2026');
    expect(formatLeaseDate(null)).toBe('');
  });

  it('has a catalogue with unique keys and no sensitive field left unmarked', () => {
    const keys = LEASE_MERGE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of ['tenant.primary_identity_number', 'bank.account_number', 'landlord.identity_number']) {
      expect(LEASE_MERGE_FIELDS.find((f) => f.key === key)?.sensitive).toBe(true);
    }
  });
});
