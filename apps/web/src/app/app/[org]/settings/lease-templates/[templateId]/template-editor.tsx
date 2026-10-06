'use client';

import { useActionState, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { publishVersionAction, saveDraftAction } from '../actions';

export function TemplateEditor({
  org, templateId, body, draftVersionId, publishedVersion,
}: {
  org: string;
  templateId: string;
  body: string;
  draftVersionId: string | null;
  publishedVersion: number | null;
}) {
  const [saveState, saveAction, saving] = useActionState(saveDraftAction, null);
  const [publishState, publishAction, publishing] = useActionState(publishVersionAction, null);
  const [text, setText] = useState(body);

  const savedVersionId = saveState?.ok ? saveState.versionId : draftVersionId;
  const savedVersion = saveState?.ok ? saveState.version : null;

  return (
    <div className="space-y-4">
      {saveState && !saveState.ok ? (
        <ErrorState title="Could not save" detail={saveState.message} correlationId={saveState.correlationId} />
      ) : null}
      {publishState && !publishState.ok ? (
        <ErrorState title="Could not publish" detail={publishState.message} correlationId={publishState.correlationId} />
      ) : null}
      {publishState?.ok ? (
        <Card className="border-positive-600/25 bg-positive-50 p-4">
          <p className="text-sm font-semibold text-positive-600">
            Published version {publishState.version}
          </p>
          <p className="mt-1 text-sm text-ink-700">
            This version is now frozen. Editing below starts the next one, so agreements
            already issued stay reproducible from the words that produced them.
          </p>
        </Card>
      ) : null}

      <Card className="p-5">
        <form action={saveAction} className="space-y-3">
          <input type="hidden" name="org" value={org} />
          <input type="hidden" name="templateId" value={templateId} />
          <div className="flex items-baseline justify-between">
            <label htmlFor="body" className="text-sm font-medium text-ink-700">
              Agreement text
            </label>
            <span className="text-xs text-ink-500">{text.length.toLocaleString()} characters</span>
          </div>
          <textarea
            id="body" name="body" value={text} onChange={(e) => setText(e.target.value)}
            rows={28} spellCheck={false}
            placeholder={'RESIDENTIAL LEASE AGREEMENT\n\n1. PARTIES\n1.1 The Landlord: {{landlord.name}}\n1.2 The Tenant: {{tenant.primary_name}}\n...'}
            className="tabular w-full rounded-lg border border-ink-200 px-3 py-2 font-mono text-xs leading-relaxed"
          />
          <p className="text-xs text-ink-500">
            A line starting with a number keeps its numbering and hangs its text, and a line
            in capitals becomes a heading.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" disabled={saving}>
              {saving ? 'Saving…' : 'Save draft'}
            </Button>
            {savedVersion ? (
              <span className="text-xs text-ink-500">Saved as draft v{savedVersion}</span>
            ) : null}
          </div>
        </form>
      </Card>

      {savedVersionId ? (
        <Card className="p-5">
          <h2 className="text-sm font-semibold text-ink-900">Publish</h2>
          <p className="mt-1 text-sm text-ink-500">
            Only a published version can generate an agreement, and publishing freezes it.
            {publishedVersion ? ` Version ${publishedVersion} is currently published.` : ''}
          </p>
          <form action={publishAction} className="mt-3">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="templateId" value={templateId} />
            <input type="hidden" name="versionId" value={savedVersionId} />
            <Button type="submit" variant="primary" disabled={publishing}>
              {publishing ? 'Publishing…' : 'Publish this version'}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
