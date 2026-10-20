/**
 * The covering message, as text.
 *
 * What a resident receives is the one artefact of this feature they will
 * actually read, so the rules about filling it in are tested directly: a
 * placeholder nobody defined must survive visibly rather than vanish, and one
 * with no value must say which field was empty rather than leave a sentence
 * with a hole in it.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_INVOICE_MESSAGE, INVOICE_MESSAGE_FIELDS, messagePlaceholders, renderMessage,
} from '@propertyos/domain';

const VALUES: Record<string, string> = {
  'resident.first_name': 'Thandiwe',
  'resident.full_name': 'Thandiwe Mokoena',
  'invoice.number': 'INV-000042',
  'invoice.period': '1 November 2026 to 30 November 2026',
  'invoice.total': 'R8,350.00',
  'invoice.due_date': '01/11/2026',
  'lease.reference': 'LSE-000001',
  'unit.label': '14 Protea Street / MAIN',
  'landlord.name': 'Blue Crane Rentals',
  'portal.link': 'https://example.invalid/portal/abc',
  'invoice.link': 'https://example.invalid/portal/abc/invoices/def/invoice.pdf',
};

describe('rendering a message', () => {
  it('fills in every field the product offers', () => {
    const body = INVOICE_MESSAGE_FIELDS.map((f) => `${f.key}: {{${f.key}}}`).join('\n');
    const { text, missing, unknown } = renderMessage(body, VALUES);
    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
    for (const field of INVOICE_MESSAGE_FIELDS) {
      expect(text).toContain(`${field.key}: ${VALUES[field.key]}`);
    }
  });

  it('names an empty field rather than leaving a gap', () => {
    // "Dear ," is how a resident learns the landlord does not check their post.
    const { text, missing } = renderMessage('Dear {{resident.first_name}},', {});
    expect(text).toBe('Dear [resident.first_name],');
    expect(missing).toEqual(['resident.first_name']);
  });

  it('leaves a placeholder nobody defined exactly as written', () => {
    const { text, unknown } = renderMessage('Hello {{tenant.name}}', VALUES);
    expect(text).toBe('Hello {{tenant.name}}');
    expect(unknown).toEqual(['tenant.name']);
  });

  it('is case and whitespace tolerant, because people type', () => {
    expect(renderMessage('{{ Invoice.Number }}', VALUES).text).toBe('INV-000042');
  });

  it('does not re-read a value as a placeholder', () => {
    // A resident named "{{landlord.name}}" is absurd, but a value that gets
    // re-scanned is how a template injection starts.
    const { text } = renderMessage('{{resident.full_name}}', {
      'resident.full_name': '{{landlord.name}}',
    });
    expect(text).toBe('{{landlord.name}}');
  });

  it('lists what a body uses, for the editor', () => {
    expect(messagePlaceholders('{{invoice.total}} due {{invoice.due_date}} {{invoice.total}}'))
      .toEqual(['invoice.due_date', 'invoice.total']);
  });
});

describe('the default message', () => {
  it('uses only fields this product fills in', () => {
    const keys = new Set(INVOICE_MESSAGE_FIELDS.map((f) => f.key));
    for (const key of messagePlaceholders(
      `${DEFAULT_INVOICE_MESSAGE.subject}\n${DEFAULT_INVOICE_MESSAGE.body}`,
    )) {
      expect(keys.has(key), `${key} is not a field`).toBe(true);
    }
  });

  it('says what it is, what it comes to and when it is due', () => {
    const { text, missing } = renderMessage(DEFAULT_INVOICE_MESSAGE.body, VALUES);
    expect(missing).toEqual([]);
    expect(text).toContain('INV-000042');
    expect(text).toContain('R8,350.00');
    expect(text).toContain('01/11/2026');
    expect(text).toContain('https://example.invalid/portal/abc');
  });

  it('claims nothing about payment and threatens nobody', () => {
    const body = DEFAULT_INVOICE_MESSAGE.body.toLowerCase();
    for (const phrase of ['overdue', 'legal action', 'eviction', 'immediately', 'failure to pay']) {
      expect(body, `the default message should not say "${phrase}"`).not.toContain(phrase);
    }
  });
});
