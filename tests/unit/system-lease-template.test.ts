/**
 * The lease template Spike ships.
 *
 * A placeholder that is not a real merge field does not fail loudly: it renders
 * as [its.name] in the generated agreement and is reported as missing. That is
 * the right behaviour for a customer's own wording — never silently blank — but
 * for the template we ship it would be our typo on their lease, so it is caught
 * here instead.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { LEASE_MERGE_FIELDS, templatePlaceholders } from '@propertyos/domain';

const MIGRATIONS = fileURLToPath(new URL('../../packages/db/migrations/', import.meta.url));

/**
 * Every migration that publishes a system template version, not just the first.
 *
 * Discovered from the directory rather than listed, because a list is a thing
 * someone forgets to add to: the master lease landed in its own migration and
 * went unchecked until this was generalised, which is exactly how a typo'd merge
 * field reaches a real tenant's lease as "[tenant.primary_nmae]".
 */
function templateMigrations(): { file: string; body: string }[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ file: f, text: readFileSync(MIGRATIONS + f, 'utf8') }))
    .filter((m) => m.text.includes('insert into system_lease_template_versions'))
    .map(({ file, text }) => {
      const open = text.indexOf('$BODY$');
      const close = text.lastIndexOf('$BODY$');
      expect(open, `${file}: the template body should be dollar-quoted`).toBeGreaterThan(-1);
      expect(close, `${file}: unterminated body`).toBeGreaterThan(open);
      return { file, body: text.slice(open + 6, close) };
    });
}

/** The newest shipped version: the one a customer copying today would get. */
function body(): string {
  const all = templateMigrations();
  expect(all.length, 'no system template migration found').toBeGreaterThan(0);
  return all[all.length - 1]!.body;
}

describe('the shipped residential lease template', () => {
  const known = new Set(LEASE_MERGE_FIELDS.map((f) => f.key));

  it('uses only merge fields the generator knows how to fill, in every version', () => {
    for (const { file, body: text } of templateMigrations()) {
      const unknown = templatePlaceholders(text).filter((p) => !known.has(p));
      expect(unknown, `${file}: these would print as [name] on a real lease`).toEqual([]);
    }
  });

  it('states that it is not legal advice, in every version', () => {
    for (const { file, body: text } of templateMigrations()) {
      expect(text, file).toMatch(/not\s+legal\s+advice/i);
    }
  });

  it('keeps the deposit rules the Rental Housing Act requires', () => {
    const text = body();
    expect(text, 'interest-bearing account').toMatch(/interest-bearing/i);
    expect(text, 'incoming and outgoing inspection').toMatch(/inspect/i);
    expect(text, 'refund period').toMatch(/seven\s+days/i);
  });

  /**
   * The source documents the master was merged from included a clause letting
   * the landlord cut services, force entry and remove a tenant's goods without a
   * court order. It is not in the master, and this is what keeps it out.
   */
  it('never authorises self-help against a tenant, in any version', () => {
    for (const { file, body: text } of templateMigrations()) {
      expect(text, `${file}: eviction must need a court`)
        .toMatch(/(only\s+evict[\s\S]*?by\s+order\s+of\s+a\s+court|court\s+order[\s\S]*?evict|Eviction\s+requires\s+a\s+court\s+order)/i);
      expect(text, `${file}: a court order is never dispensed with`)
        .not.toMatch(/court\s+order\s+is\s+not\s+necessary/i);
      expect(text, `${file}: services are never cut to force payment`)
        .not.toMatch(/disconnect\s+the\s+electricity/i);
    }
  });

  /** Section 5 of the Rental Housing Act: the deposit earns interest for the tenant. */
  it('never holds the deposit in a non-interest bearing account', () => {
    for (const { file, body: text } of templateMigrations()) {
      expect(text, file).not.toMatch(/non[\s-]?interest[\s-]?bearing/i);
    }
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
    // Checked on the newest version only: the phrasing is wording, not a rule
    // every version must carry in the same words.
    // The same rule the rest of the product enforces: evidence is not money.
    // Whitespace-tolerant: the body is hard-wrapped, so the phrase can straddle
    // a line break.
    expect(body()).toMatch(/is\s+not\s+payment/i);
  });
});
