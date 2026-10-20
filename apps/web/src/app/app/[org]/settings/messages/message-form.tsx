'use client';

import { useActionState, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import type { MessageField } from '@propertyos/domain';
import { resetMessageAction, saveMessageAction } from './actions';

/**
 * The covering message, with a preview beside it.
 *
 * The preview is rendered in the browser from the same `{{field}}` convention
 * the server uses, against the example values the catalogue carries. It is a
 * preview of the WORDING, not a prediction of any particular invoice — which
 * is why the examples are obviously examples.
 */
export function MessageForm({
  org, subject, body, fields, customised, updatedAt, updatedByName,
}: {
  org: string;
  subject: string;
  body: string;
  fields: readonly MessageField[];
  customised: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
}) {
  const [state, action, pending] = useActionState(saveMessageAction, null);
  const [resetState, reset, resetting] = useActionState(resetMessageAction, null);
  const [draftSubject, setDraftSubject] = useState(subject);
  const [draftBody, setDraftBody] = useState(body);

  const examples = new Map(fields.map((f) => [f.key, f.example]));
  const fill = (text: string) => text.replace(
    /\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/gi,
    (whole, key: string) => examples.get(key.toLowerCase()) ?? whole,
  );
  const unknown = [...new Set(
    [...`${draftSubject}\n${draftBody}`.matchAll(
      /\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/gi,
    )].map((m) => m[1]!.toLowerCase()),
  )].filter((key) => !examples.has(key));

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <form action={action} className="space-y-3">
        <input type="hidden" name="org" value={org} />
        {state && !state.ok ? (
          <ErrorState
            title="Not saved"
            detail={state.message ?? ''}
            correlationId={state.correlationId}
          />
        ) : null}

        <div>
          <label
            htmlFor="subject"
            className="block text-[length:var(--text-table)] font-medium text-ink-700"
          >
            Subject
          </label>
          <input
            id="subject" name="subject" value={draftSubject}
            onChange={(event) => setDraftSubject(event.target.value)}
            className="
              mt-1 w-full rounded-[var(--radius-control)] border border-ink-200 bg-surface
              px-3 py-2 text-[length:var(--text-table)] text-ink-900
            "
          />
        </div>

        <div>
          <label
            htmlFor="body"
            className="block text-[length:var(--text-table)] font-medium text-ink-700"
          >
            Message
          </label>
          <textarea
            id="body" name="body" rows={16} value={draftBody}
            onChange={(event) => setDraftBody(event.target.value)}
            className="
              mt-1 w-full rounded-[var(--radius-control)] border border-ink-200 bg-surface
              px-3 py-2 font-[var(--font-sans)] text-[length:var(--text-table)] text-ink-900
            "
          />
        </div>

        {unknown.length > 0 ? (
          <p className="
            rounded-[var(--radius-control)] border border-caution-700/25 bg-caution-50 px-3 py-2
            text-[length:var(--text-table)] text-caution-700
          ">
            {unknown.map((key) => `{{${key}}}`).join(', ')}{' '}
            {unknown.length === 1 ? 'is not a field' : 'are not fields'} this product fills in.
            Saving will be refused rather than sending the braces to a resident.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Saving…' : 'Save this message'}
          </Button>
          {state?.ok ? (
            <span className="text-[length:var(--text-meta)] font-medium text-positive-600">
              Saved. It applies to invoices sent from now on.
            </span>
          ) : null}
        </div>

        {customised ? (
          <p className="text-[length:var(--text-meta)] text-ink-500">
            Your own wording, last changed {updatedAt?.slice(0, 10)}
            {updatedByName ? ` by ${updatedByName}` : ''}.
          </p>
        ) : (
          <p className="text-[length:var(--text-meta)] text-ink-500">
            This is the product&rsquo;s default wording. Edit it and it becomes yours.
          </p>
        )}
      </form>

      <div className="space-y-4">
        <div className="rounded-[var(--radius-card)] border border-ink-100 bg-surface">
          <div className="border-b border-ink-100 px-4 py-2.5">
            <p className="text-[length:var(--text-meta)] uppercase tracking-[0.08em] text-ink-400">
              Preview, with example values
            </p>
            <p className="mt-1 text-[length:var(--text-table)] font-semibold text-ink-900">
              {fill(draftSubject)}
            </p>
          </div>
          <pre className="
            whitespace-pre-wrap px-4 py-3 font-[var(--font-sans)]
            text-[length:var(--text-table)] text-ink-700
          ">
            {fill(draftBody)}
          </pre>
        </div>

        <div className="rounded-[var(--radius-card)] border border-ink-100 bg-surface">
          <p className="border-b border-ink-100 px-4 py-2.5 text-[length:var(--text-table)] font-medium text-ink-900">
            Fields you can use
          </p>
          <ul className="divide-y divide-ink-100">
            {fields.map((field) => (
              <li key={field.key} className="flex items-baseline justify-between gap-3 px-4 py-2">
                <code className="technical text-[length:var(--text-meta)] text-spike-700">
                  {`{{${field.key}}}`}
                </code>
                <span className="text-[length:var(--text-meta)] text-ink-500">{field.label}</span>
              </li>
            ))}
          </ul>
        </div>

        {customised ? (
          <form action={reset}>
            <input type="hidden" name="org" value={org} />
            {resetState && !resetState.ok ? (
              <ErrorState
                title="Could not reset"
                detail={resetState.message ?? ''}
                correlationId={resetState.correlationId}
              />
            ) : null}
            <Button type="submit" variant="secondary" disabled={resetting}>
              {resetting ? 'Restoring…' : 'Go back to the default wording'}
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}
