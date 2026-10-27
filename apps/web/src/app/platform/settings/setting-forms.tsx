'use client';

import { useActionState, useState } from 'react';
import { Button, Card, StatusBadge } from '@propertyos/ui';
import {
  clearOrganisationSettingAction, clearPlatformSettingAction,
  setOrganisationSettingAction, setPlatformSettingAction,
} from './actions';

/**
 * One setting, with its default always in view.
 *
 * The default is shown beside the value rather than only when it is in force,
 * because the question somebody actually has is "is this what we shipped, and
 * what happens if I undo it?". A screen that hides the default makes clearing
 * a value feel like deleting something.
 */

const FIELD = 'w-full rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm text-ink-900';
const LABEL = 'block text-sm font-medium text-ink-700';

export interface SettingView {
  key: string;
  name: string;
  description: string;
  valueType: 'boolean' | 'integer';
  defaultValue: string;
  globalValue: string | null;
  globalReason: string | null;
  globalSetByName: string | null;
  effectiveValue: string;
  minValue: number | null;
  maxValue: number | null;
  perOrganisation: boolean;
  customerVisible: boolean;
  overrides: number;
}

function ValueInput({
  setting, id, defaultValue,
}: { setting: SettingView; id: string; defaultValue: string }) {
  if (setting.valueType === 'boolean') {
    return (
      <select id={id} name="value" defaultValue={defaultValue} className={`mt-1 ${FIELD}`}>
        <option value="true">On</option>
        <option value="false">Off</option>
      </select>
    );
  }
  return (
    <input
      id={id} name="value" type="number" required defaultValue={defaultValue}
      {...(setting.minValue !== null ? { min: setting.minValue } : {})}
      {...(setting.maxValue !== null ? { max: setting.maxValue } : {})}
      className={`mt-1 ${FIELD}`}
    />
  );
}

function describe(setting: SettingView, value: string): string {
  return setting.valueType === 'boolean' ? (value === 'true' ? 'On' : 'Off') : value;
}

export function PlatformSettingRow({
  setting, canManage,
}: { setting: SettingView; canManage: boolean }) {
  const [saved, save, saving] = useActionState(setPlatformSettingAction, null);
  const [cleared, clear, clearing] = useActionState(clearPlatformSettingAction, null);
  const [open, setOpen] = useState(false);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-ink-900">{setting.name}</p>
          <p className="tabular text-xs text-ink-400">{setting.key}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge
            tone={setting.globalValue === null ? 'neutral' : 'info'}
            glyph={setting.globalValue === null ? '○' : '◆'}
          >
            {describe(setting, setting.effectiveValue)}
            {setting.globalValue === null ? ' — the default' : ' — set by Spike'}
          </StatusBadge>
          {setting.overrides > 0 ? (
            <StatusBadge tone="caution" glyph="＋">
              {setting.overrides} customer{setting.overrides === 1 ? '' : 's'} differ
            </StatusBadge>
          ) : null}
        </div>
      </div>
      <p className="mt-0.5 text-sm text-ink-700">{setting.description}</p>
      <p className="mt-1 text-xs text-ink-500">
        Ships as <strong>{describe(setting, setting.defaultValue)}</strong>
        {setting.minValue !== null || setting.maxValue !== null
          ? ` · between ${setting.minValue ?? '—'} and ${setting.maxValue ?? '—'}`
          : ''}
        {setting.perOrganisation
          ? ' · can differ per customer, on their own page'
          : ' · the same for every customer'}
        {setting.globalReason ? ` · ${setting.globalReason}` : ''}
        {setting.globalSetByName ? ` (${setting.globalSetByName})` : ''}
      </p>

      {saved && !saved.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{saved.message}</p>
        </div>
      ) : null}
      {cleared && !cleared.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{cleared.message}</p>
        </div>
      ) : null}

      {canManage ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((shown) => !shown)}
            className="mt-2 text-sm font-medium text-spike-600 hover:underline"
          >
            {open ? 'Leave it alone' : 'Change it'}
          </button>
          {open ? (
            <div className="mt-2 space-y-3 border-t border-ink-100 pt-3">
              <form action={save} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="key" value={setting.key} />
                <div className="w-32">
                  <label className={LABEL} htmlFor={`value-${setting.key}`}>Value</label>
                  <ValueInput
                    setting={setting} id={`value-${setting.key}`}
                    defaultValue={setting.effectiveValue}
                  />
                </div>
                <div className="min-w-60 flex-1">
                  <label className={LABEL} htmlFor={`why-${setting.key}`}>Why</label>
                  <input
                    id={`why-${setting.key}`} name="reason" required minLength={5} maxLength={500}
                    placeholder="Agreed at the review on 12 March"
                    className={`mt-1 ${FIELD}`}
                  />
                </div>
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </form>

              {setting.globalValue !== null ? (
                <form action={clear} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="key" value={setting.key} />
                  <div className="min-w-60 flex-1">
                    <label className={LABEL} htmlFor={`clear-${setting.key}`}>
                      Or put it back to {describe(setting, setting.defaultValue)}, because
                    </label>
                    <input
                      id={`clear-${setting.key}`} name="reason" required
                      minLength={5} maxLength={500}
                      placeholder="The experiment is over"
                      className={`mt-1 ${FIELD}`}
                    />
                  </div>
                  <Button type="submit" disabled={clearing}>
                    {clearing ? 'Clearing…' : 'Back to the default'}
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

export interface CustomerSettingView {
  key: string;
  name: string;
  description: string;
  valueType: 'boolean' | 'integer';
  effectiveValue: string;
  ownValue: string | null;
  ownReason: string | null;
  setByName: string | null;
  customerVisible: boolean;
}

/**
 * The same settings, for one customer.
 *
 * "Theirs" and "everybody's" are kept visibly different: an operator looking
 * at a customer needs to know whether a value is a decision somebody made
 * about them or simply what everyone gets, and the two look identical if only
 * the value is shown.
 */
export function CustomerSettings({
  organisationId, slug, customerName, settings, canManage,
}: {
  organisationId: string;
  slug: string;
  customerName: string;
  settings: CustomerSettingView[];
  canManage: boolean;
}) {
  const [saved, save, saving] = useActionState(setOrganisationSettingAction, null);
  const [cleared, clear, clearing] = useActionState(clearOrganisationSettingAction, null);
  const [editing, setEditing] = useState<string | null>(null);

  if (settings.length === 0) return null;

  return (
    <Card className="p-5">
      <h2 className="text-sm font-semibold text-ink-900">Features</h2>
      <p className="mt-1 text-sm text-ink-700">
        What is switched on for {customerName}. Anything not set here is whatever every
        other customer gets.
      </p>

      {saved && !saved.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{saved.message}</p>
        </div>
      ) : null}
      {cleared && !cleared.ok ? (
        <div className="mt-3 rounded-lg border border-critical-700/25 bg-critical-50 px-3 py-2">
          <p className="text-sm text-critical-700">{cleared.message}</p>
        </div>
      ) : null}

      <ul className="mt-3 divide-y divide-ink-100 border-t border-ink-100">
        {settings.map((setting) => (
          <li key={setting.key} className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm text-ink-900">
                  {setting.name}{' '}
                  <strong
                    className={setting.effectiveValue === 'false' ? 'text-critical-700' : ''}
                  >
                    {setting.valueType === 'boolean'
                      ? (setting.effectiveValue === 'true' ? 'on' : 'off')
                      : setting.effectiveValue}
                  </strong>
                </p>
                <p className="text-xs text-ink-500">
                  {setting.ownValue === null
                    ? 'Whatever every other customer gets.'
                    : `Theirs: ${setting.ownReason ?? ''}${
                      setting.setByName ? ` (${setting.setByName})` : ''}`}
                </p>
              </div>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => setEditing(editing === setting.key ? null : setting.key)}
                  className="text-sm font-medium text-spike-600 hover:underline"
                >
                  {editing === setting.key ? 'Leave it' : 'Change'}
                </button>
              ) : null}
            </div>

            {editing === setting.key ? (
              <div className="mt-2 space-y-2">
                <form action={save} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="organisationId" value={organisationId} />
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="key" value={setting.key} />
                  <div className="w-28">
                    <label className={LABEL} htmlFor={`cv-${setting.key}`}>Value</label>
                    <select
                      id={`cv-${setting.key}`} name="value"
                      defaultValue={setting.effectiveValue}
                      className={`mt-1 ${FIELD}`}
                    >
                      <option value="true">On</option>
                      <option value="false">Off</option>
                    </select>
                  </div>
                  <div className="min-w-60 flex-1">
                    <label className={LABEL} htmlFor={`cr-${setting.key}`}>
                      Who asked, and why
                    </label>
                    <input
                      id={`cr-${setting.key}`} name="reason" required
                      minLength={5} maxLength={500}
                      placeholder="SPK-1234: they take maintenance calls by phone only"
                      className={`mt-1 ${FIELD}`}
                    />
                  </div>
                  <Button type="submit" variant="primary" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </Button>
                </form>

                {setting.ownValue !== null ? (
                  <form action={clear} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="organisationId" value={organisationId} />
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="key" value={setting.key} />
                    <div className="min-w-60 flex-1">
                      <label className={LABEL} htmlFor={`cc-${setting.key}`}>
                        Or give them whatever everybody else gets, because
                      </label>
                      <input
                        id={`cc-${setting.key}`} name="reason" required
                        minLength={5} maxLength={500}
                        placeholder="They changed their mind"
                        className={`mt-1 ${FIELD}`}
                      />
                    </div>
                    <Button type="submit" disabled={clearing}>
                      {clearing ? 'Clearing…' : 'Same as everybody'}
                    </Button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      {canManage ? (
        <p className="mt-3 text-xs text-ink-500">
          {customerName} sees anything switched off here on their own settings screen, with
          your reason.
        </p>
      ) : (
        <p className="mt-3 text-xs text-ink-500">
          Your platform role does not include changing configuration, so this is read-only
          for you.
        </p>
      )}
    </Card>
  );
}
