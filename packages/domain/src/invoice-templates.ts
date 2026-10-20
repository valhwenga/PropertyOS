/**
 * The invoice designs this product offers.
 *
 * Its own module because two things need it and they must not need each other:
 * the renderer draws them, and the branding command validates what a landlord
 * chose. A key from this list is the only thing that reaches the database.
 */

export interface InvoiceTemplate {
  key: string;
  label: string;
  description: string;
}

/**
 * The designs on offer.
 *
 * Deliberately three. Each one was laid out and read; a fourth that nobody has
 * read is not a choice, it is a risk with a name.
 */
export const INVOICE_TEMPLATES: readonly InvoiceTemplate[] = [
  {
    key: 'classic',
    label: 'Classic',
    description:
      'Ruled and formal, like a statement. The most familiar to an accountant '
      + 'or a rental housing tribunal, and the cheapest to print.',
  },
  {
    key: 'modern',
    label: 'Modern',
    description:
      'A coloured band carrying your logo, with the amount due set large in '
      + 'your accent colour. The most distinctive, and it uses the most ink.',
  },
  {
    key: 'compact',
    label: 'Compact',
    description:
      'Everything on the top half of one page, in smaller type. Suits a single '
      + 'rent line and reads well on a phone.',
  },
] as const;

export function invoiceTemplateByKey(key: string | null | undefined): InvoiceTemplate {
  return INVOICE_TEMPLATES.find((t) => t.key === key) ?? INVOICE_TEMPLATES[0]!;
}
