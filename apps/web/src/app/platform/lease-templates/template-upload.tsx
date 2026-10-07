'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { FieldErrors } from '@/components/field-errors';
import {
  addSystemTemplateVersionAction, createSystemTemplateAction, publishSystemTemplateAction,
} from './actions';

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export function NewSystemTemplate() {
  const [state, action, pending] = useActionState(createSystemTemplateAction, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return <Button variant="primary" onClick={() => setOpen(true)}>Add a template</Button>;
  }

  return (
    <Card className="p-5">
      <form action={action} className="space-y-4">
        {state && !state.ok ? (
          <div>
            <ErrorState title="Could not add this template" detail={state.message}
                        correlationId={state.correlationId} />
            <FieldErrors errors={state.fieldErrors} />
          </div>
        ) : null}
        {state?.ok ? (
          <p className="text-sm text-positive-600">
            Added as a draft. Publish it to make it visible to customers.
          </p>
        ) : null}

        <div>
          <label className={LABEL} htmlFor="name">Name</label>
          <input id="name" name="name" required className={`mt-1 ${FIELD}`}
                 placeholder="Residential lease — South Africa" />
        </div>
        <div>
          <label className={LABEL} htmlFor="provenance">Where this wording came from</label>
          <input id="provenance" name="provenance" required className={`mt-1 ${FIELD}`}
                 placeholder="Drafted by …, or licensed from … under …" />
          <p className="mt-1 text-xs text-ink-500">
            Customers see this before adopting. If the wording is licensed to Spike, say so and say
            whether the licence lets customers use and adapt it.
          </p>
        </div>
        <div>
          <label className={LABEL} htmlFor="summary">Summary</label>
          <input id="summary" name="summary" className={`mt-1 ${FIELD}`}
                 placeholder="What it covers, and who it suits." />
        </div>
        <div>
          <label className={LABEL} htmlFor="body">Template body</label>
          <textarea id="body" name="body" required rows={16}
                    className={`mt-1 ${FIELD} font-mono text-xs`}
                    placeholder={'Plain text. Use {{merge.fields}} where PropertyOS should fill a value.'} />
          <p className="mt-1 text-xs text-ink-500">
            Plain text with <code>{'{{group.field}}'}</code> placeholders. Any placeholder that is
            not a known field prints as <code>[group.field]</code> on the agreement and is reported
            as missing — it is never silently blank.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Adding…' : 'Add as draft'}
          </Button>
          <button type="button" onClick={() => setOpen(false)}
                  className="text-sm text-ink-500 hover:underline">Close</button>
        </div>
      </form>
    </Card>
  );
}

export function PublishButton({ templateId, label }: { templateId: string; label: string }) {
  const [state, action, pending] = useActionState(publishSystemTemplateAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="templateId" value={templateId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Publishing…' : label}
      </Button>
      {state && !state.ok ? (
        <span className="ml-2 text-xs text-critical-700">{state.message}</span>
      ) : null}
      {state?.ok ? (
        <span className="ml-2 text-xs text-ink-500">
          Published v{state.version}.{' '}
          {state.notified.people === 0
            ? 'Nobody had adopted it, so nobody was told.'
            : `Told ${state.notified.people} ${state.notified.people === 1 ? 'person' : 'people'} across ${state.notified.organisations} ${state.notified.organisations === 1 ? 'customer' : 'customers'}. Their wording is unchanged.`}
        </span>
      ) : null}
    </form>
  );
}

export function NewVersionForm({ templateId }: { templateId: string }) {
  const [state, action, pending] = useActionState(addSystemTemplateVersionAction, null);
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-spike-700 hover:underline">
        New version
      </button>
    );
  }
  return (
    <form action={action} className="mt-2 space-y-2">
      <input type="hidden" name="templateId" value={templateId} />
      <textarea name="body" required rows={10} className={`${FIELD} font-mono text-xs`}
                placeholder="The full replacement wording." />
      {state && !state.ok ? (
        <p className="text-xs text-critical-700">{state.message}</p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? 'Saving…' : 'Save as draft version'}
        </Button>
        <button type="button" onClick={() => setOpen(false)}
                className="text-sm text-ink-500 hover:underline">Cancel</button>
      </div>
    </form>
  );
}
