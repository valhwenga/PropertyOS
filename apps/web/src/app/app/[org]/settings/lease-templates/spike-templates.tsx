'use client';

import { useActionState } from 'react';
import { Button, Card, ErrorState, StatusBadge } from '@propertyos/ui';
import { adoptSystemTemplateAction } from './actions';

export interface SpikeTemplate {
  id: string;
  name: string;
  provenance: string;
  summary: string;
  version: number;
  alreadyCopied: boolean;
}

/**
 * Templates Spike provides, offered as a starting point.
 *
 * Adopting one copies it into this organisation. It is deliberately a copy and
 * not a live link: wording on a signed lease must not change because Spike
 * edited something later.
 */
export function SpikeTemplates({ org, templates }: { org: string; templates: SpikeTemplate[] }) {
  const [state, action, pending] = useActionState(adoptSystemTemplateAction, null);
  if (templates.length === 0) return null;

  return (
    <section aria-labelledby="spike-templates" className="space-y-3">
      <h2 id="spike-templates" className="text-sm font-semibold uppercase tracking-wide text-ink-500">
        Templates from Spike
      </h2>

      {state && !state.ok ? (
        <ErrorState title="Could not copy that template" detail={state.message}
                    correlationId={state.correlationId} />
      ) : null}
      {state?.ok ? (
        <Card className="border-positive-600/25 bg-positive-50 p-3">
          <p className="text-sm text-ink-700">
            <strong>{state.name}</strong> was copied into your templates as a draft. Edit it to suit
            your properties, then publish it before generating an agreement from it.
          </p>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {templates.map((t) => (
          <Card key={t.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium text-ink-900">{t.name}</p>
              {t.alreadyCopied ? <StatusBadge tone="neutral">Already copied</StatusBadge> : null}
            </div>
            <p className="text-sm text-ink-500">{t.summary}</p>
            <p className="text-xs text-ink-400">{t.provenance}</p>
            <form action={action} className="mt-auto pt-2">
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="systemTemplateId" value={t.id} />
              <Button type="submit" variant="secondary" disabled={pending}>
                {t.alreadyCopied ? 'Copy again' : 'Copy to my templates'}
              </Button>
            </form>
          </Card>
        ))}
      </div>

      <p className="text-xs text-ink-500">
        A copy is yours from the moment you take it. Spike changing its version later never alters
        wording you have already adopted, and never alters an agreement already generated.
      </p>
    </section>
  );
}
