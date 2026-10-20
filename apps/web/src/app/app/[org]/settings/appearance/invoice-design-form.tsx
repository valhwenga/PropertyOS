'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import type { Branding, InvoiceTemplate } from '@propertyos/domain';
import { saveInvoiceTemplateAction } from './actions';

/**
 * Choosing which invoice your tenants receive.
 *
 * A design is a thing you look at, so each option links to a specimen rendered
 * with THIS organisation's colour and logo — invented figures, an invented
 * tenant, and SAMPLE printed on its face. Choosing from three descriptions
 * without seeing one is how a landlord discovers their layout at the moment a
 * tenant complains about it.
 *
 * The radios are uncontrolled, with `defaultChecked` from what the server last
 * saved: a Server Action resets the form it was submitted from to the current
 * render's defaults, so a controlled radio silently reverts.
 */
export function InvoiceDesignForm({
  org, branding, templates,
}: {
  org: string;
  branding: Branding;
  templates: readonly InvoiceTemplate[];
}) {
  const [state, action, pending] = useActionState(saveInvoiceTemplateAction, null);
  // Only to point the "view a sample" link at whatever is currently selected.
  const [preview, setPreview] = useState(branding.invoiceTemplate);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="org" value={org} />
      {state && !state.ok ? (
        <ErrorState
          title="Not saved"
          detail={state.message ?? ''}
          correlationId={state.correlationId}
        />
      ) : null}

      <fieldset>
        <legend className="sr-only">Invoice design</legend>
        <div className="space-y-2">
          {templates.map((template) => (
            <label
              key={template.key}
              className="
                flex items-start gap-3 rounded-[var(--radius-control)] border border-ink-200
                p-3 hover:bg-ink-50 has-[:checked]:border-spike-500 has-[:checked]:bg-spike-50
              "
            >
              <input
                type="radio"
                name="invoiceTemplate"
                value={template.key}
                defaultChecked={branding.invoiceTemplate === template.key}
                onChange={() => setPreview(template.key)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-[length:var(--text-table)] font-medium text-ink-900">
                  {template.label}
                </span>
                <span className="block text-[length:var(--text-meta)] text-ink-500">
                  {template.description}
                </span>
                <a
                  href={`/app/${org}/settings/appearance/sample-invoice.pdf?template=${template.key}`}
                  target="_blank"
                  rel="noopener"
                  className="
                    mt-1 inline-block text-[length:var(--text-meta)] font-medium text-spike-600
                    hover:underline
                  "
                >
                  See a sample of {template.label} (PDF)
                </a>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save invoice design'}
        </Button>
        <a
          href={`/app/${org}/settings/appearance/sample-invoice.pdf?template=${preview}`}
          target="_blank"
          rel="noopener"
          className="text-[length:var(--text-meta)] text-ink-500 hover:underline"
        >
          Open the selected design as a sample
        </a>
        {state?.ok ? (
          <span className="text-[length:var(--text-meta)] font-medium text-positive-600">
            Saved. Invoices generated from now on use it.
          </span>
        ) : null}
      </div>
    </form>
  );
}
