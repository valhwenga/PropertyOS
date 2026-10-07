/**
 * The lease template Spike ships.
 *
 * A placeholder that is not a real merge field does not fail loudly: it renders
 * as [its.name] in the generated agreement and is reported as missing. That is
 * the right behaviour for a customer's own wording — never silently blank — but
 * for the template we ship it would be our typo on their lease, so it is caught
 * here instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LEASE_MERGE_FIELDS, templatePlaceholders } from '@propertyos/domain';

const migration = readFileSync(
  fileURLToPath(new URL('../../packages/db/migrations/0024_spike_residential_lease_template.sql', import.meta.url)),
  'utf8',
);

/** The body is the text between the dollar-quoted delimiters. */
function body(): string {
  const open = migration.indexOf('$BODY$');
  const close = migration.lastIndexOf('$BODY$');
  expect(open, 'the template body should still be dollar-quoted').toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return migration.slice(open + 6, close);
}

describe('the shipped residential lease template', () => {
  const known = new Set(LEASE_MERGE_FIELDS.map((f) => f.key));

  it('uses only merge fields the generator knows how to fill', () => {
    const unknown = templatePlaceholders(body()).filter((p) => !known.has(p));
    expect(unknown, 'these would print as [name] on a real lease').toEqual([]);
  });

  it('states that it is not legal advice', () => {
    expect(body()).toMatch(/not\s+legal\s+advice/i);
  });

  it('keeps the deposit rules the Rental Housing Act requires', () => {
    const text = body();
    expect(text, 'interest-bearing account').toMatch(/interest-bearing/i);
    expect(text, 'incoming and outgoing inspection').toMatch(/inspect/i);
    expect(text, 'refund period').toMatch(/seven\s+days/i);
  });

  it('refuses the landlord self-help eviction PIE prohibits', () => {
    expect(body()).toMatch(/only\s+evict[\s\S]*?by\s+order\s+of\s+a\s+court/i);
  });

  it('is documented: docs/lease-templates.md lists every field', () => {
    // The doc is what a customer writes a template against. A field present in
    // the catalogue but missing from the doc is a field nobody knows to use.
    const doc = readFileSync(
      fileURLToPath(new URL('../../docs/lease-templates.md', import.meta.url)),
      'utf8',
    );
    const undocumented = [...known].filter((key) => !doc.includes(`{{${key}}}`));
    expect(undocumented).toEqual([]);
  });

  it('says proof of payment is not payment', () => {
    // The same rule the rest of the product enforces: evidence is not money.
    // Whitespace-tolerant: the body is hard-wrapped, so the phrase can straddle
    // a line break.
    expect(body()).toMatch(/is\s+not\s+payment/i);
  });
});
