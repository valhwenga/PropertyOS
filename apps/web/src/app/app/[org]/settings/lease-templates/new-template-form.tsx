'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { createTemplateAction } from './actions';

export function NewTemplateForm({ org }: { org: string }) {
  const [state, action, pending] = useActionState(createTemplateAction, null);

  return (
    <Card className="p-5">
      <h2 className="text-base font-semibold text-ink-900">New template</h2>
      <p className="mt-1 text-sm text-ink-500">
        You can keep several — one per property type, or one per lease pack version.
      </p>

      {state && !state.ok ? (
        <div className="mt-4">
          <ErrorState title="Could not create the template" detail={state.message} correlationId={state.correlationId} />
        </div>
      ) : null}

      <form action={action} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="org" value={org} />

        <div className="space-y-1.5">
          <label htmlFor="name" className="block text-sm font-medium text-ink-700">
            Name
          </label>
          <input
            id="name" name="name" required minLength={3} maxLength={120}
            placeholder="Residential lease — natural person"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="layout" className="block text-sm font-medium text-ink-700">
            Layout
          </label>
          <select
            id="layout" name="layout"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          >
            <option value="schedule">Schedule — variables in a numbered schedule</option>
            <option value="inline">Inline — variables inside the clauses</option>
          </select>
          <p className="text-xs text-ink-500">
            Only affects how the document reads. Both use the same placeholders.
          </p>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="sourceNote" className="block text-sm font-medium text-ink-700">
            Source <span className="font-normal text-ink-500">(optional)</span>
          </label>
          <input
            id="sourceNote" name="sourceNote" maxLength={500}
            placeholder="e.g. TPN LeasePack 8.4, adapted — licence held by this agency"
            className="w-full rounded-lg border border-ink-200 px-3 py-2 text-sm"
          />
          <p className="text-xs text-ink-500">
            Where this wording came from, so the next person knows what they are editing.
          </p>
        </div>

        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create template'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
