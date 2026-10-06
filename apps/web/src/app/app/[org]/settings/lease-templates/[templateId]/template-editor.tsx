'use client';

import { useActionState, useMemo, useRef, useState } from 'react';
import { Button, Card, ErrorState } from '@propertyos/ui';
import { publishVersionAction, saveDraftAction } from '../actions';

export interface CatalogueField {
  key: string;
  label: string;
  group: string;
  sensitive?: boolean;
}

export function TemplateEditor({
  org, templateId, body, draftVersionId, publishedVersion, fields,
}: {
  org: string;
  templateId: string;
  body: string;
  draftVersionId: string | null;
  publishedVersion: number | null;
  fields: CatalogueField[];
}) {
  const [saveState, saveAction, saving] = useActionState(saveDraftAction, null);
  const [publishState, publishAction, publishing] = useActionState(publishVersionAction, null);
  const [text, setText] = useState(body);
  const [filter, setFilter] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);

  const savedVersionId = saveState?.ok ? saveState.versionId : draftVersionId;
  const savedVersion = saveState?.ok ? saveState.version : null;

  // Which placeholders this template already uses, so the catalogue shows at a
  // glance what is covered and what is not.
  const used = useMemo(
    () => new Set([...text.matchAll(/\{\{\s*([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*\}\}/gi)].map((m) => m[1]!.toLowerCase())),
    [text],
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? fields.filter((f) => f.key.includes(needle) || f.label.toLowerCase().includes(needle))
      : fields;
    const out = new Map<string, CatalogueField[]>();
    for (const f of matching) out.set(f.group, [...(out.get(f.group) ?? []), f]);
    return [...out];
  }, [fields, filter]);

  /** Inserts at the cursor rather than appending, so it lands where you are. */
  const insert = (key: string) => {
    const el = textarea.current;
    const token = `{{${key}}}`;
    if (!el) { setText((t) => t + token); return; }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    const next = text.slice(0, start) + token + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_19rem] lg:items-start">
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
              <span className="text-xs text-ink-500">
                {used.size} placeholder{used.size === 1 ? '' : 's'} · {text.length.toLocaleString()} characters
              </span>
            </div>
            <textarea
              ref={textarea}
              id="body" name="body" value={text} onChange={(e) => setText(e.target.value)}
              rows={34} spellCheck={false}
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

      {/* Sticky so the catalogue stays beside the text you are writing, and
          scrolls on its own instead of making the page three screens tall. */}
      <Card className="p-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:overflow-y-auto">
        <h2 className="text-sm font-semibold text-ink-900">Placeholders</h2>
        <p className="mt-1 text-xs text-ink-500">
          Click one to drop it in at the cursor. A field with no value stays visible as
          <code className="mx-1 rounded bg-ink-100 px-1">[its.name]</code> and is listed on a
          final page — never silently blank.
        </p>

        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a placeholder…"
          aria-label="Find a placeholder"
          className="mt-3 w-full rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs"
        />

        <div className="mt-3 space-y-3">
          {groups.length === 0 ? (
            <p className="text-xs text-ink-500">Nothing matches “{filter}”.</p>
          ) : (
            groups.map(([group, groupFields]) => (
              <div key={group}>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{group}</p>
                <ul className="mt-1 space-y-0.5">
                  {groupFields.map((f) => (
                    <li key={f.key}>
                      <button
                        type="button"
                        onClick={() => insert(f.key)}
                        title={`Insert {{${f.key}}}`}
                        className="w-full rounded px-1 py-0.5 text-left text-xs hover:bg-spike-50"
                      >
                        <code className={used.has(f.key) ? 'text-spike-700' : 'text-ink-700'}>
                          {f.key}
                        </code>
                        {used.has(f.key) ? (
                          <span className="ml-1 text-spike-600" title="Used in this template">•</span>
                        ) : null}
                        {f.sensitive ? (
                          <span className="ml-1 text-caution-700" title="Opens a sealed value">●</span>
                        ) : null}
                        <span className="block text-[11px] leading-tight text-ink-500">{f.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        <p className="mt-4 border-t border-ink-100 pt-3 text-[11px] leading-tight text-ink-500">
          <span className="text-spike-600">•</span> already used ·{' '}
          <span className="text-caution-700">●</span> opens a sealed identity or account number,
          which is recorded in the audit trail.
        </p>
      </Card>
    </div>
  );
}
