'use client';

import { useActionState, useEffect, useState } from 'react';
import { ErrorState } from '@propertyos/ui';
import { saveThemeAction } from './actions';
import { THEME_STORAGE_KEY, type ThemeChoice } from '@/lib/theme';

const OPTIONS: Array<{ value: ThemeChoice; label: string; detail: string }> = [
  { value: 'light', label: 'Light', detail: 'Always the light theme.' },
  { value: 'dark', label: 'Dark', detail: 'Always the dark theme.' },
  { value: 'system', label: 'Follow my device', detail: 'Whatever this device asks for.' },
];

/**
 * The theme, chosen against the account rather than the browser.
 *
 * Applied to the page the moment it is chosen, then saved. Choosing one also
 * clears this device's own override — otherwise somebody who used the toggle
 * in the sidebar last week would save "light" here and watch nothing happen,
 * because the device's stored choice would keep winning on every page load.
 */
export function ThemeForm({ saved }: { saved: ThemeChoice }) {
  const [state, action, pending] = useActionState(saveThemeAction, null);
  const [choice, setChoice] = useState<ThemeChoice>(saved);
  const [systemPrefersDark, setSystemPrefersDark] = useState(false);

  useEffect(() => {
    setSystemPrefersDark(window.matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);

  function apply(next: ThemeChoice) {
    setChoice(next);
    const resolved = next === 'system' ? (systemPrefersDark ? 'dark' : 'light') : next;
    document.documentElement.setAttribute('data-theme', resolved);
    try {
      // The device override is deliberately removed, not rewritten: from here
      // on this account's choice is the one that decides.
      localStorage.removeItem(THEME_STORAGE_KEY);
    } catch {
      // A privacy mode can refuse storage. Nothing here depends on it.
    }
  }

  return (
    <form action={action} className="space-y-3">
      {state && !state.ok ? (
        <ErrorState
          title="Not saved"
          detail={state.message ?? ''}
          correlationId={state.correlationId}
        />
      ) : null}

      <fieldset className="space-y-2">
        <legend className="sr-only">Theme</legend>
        {OPTIONS.map((option) => (
          <label
            key={option.value}
            className="flex items-start gap-2.5 text-[length:var(--text-table)] text-ink-700"
          >
            <input
              type="radio"
              name="theme"
              value={option.value}
              checked={choice === option.value}
              onChange={() => apply(option.value)}
              className="mt-0.5"
            />
            <span>
              <span className="block font-medium text-ink-900">{option.label}</span>
              <span className="block text-[length:var(--text-meta)] text-ink-500">
                {option.detail}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="
            inline-flex items-center rounded-[var(--radius-control)] bg-spike-500 px-3.5 py-2
            text-[length:var(--text-table)] font-medium text-white hover:bg-spike-600
            disabled:opacity-50
          "
        >
          {pending ? 'Saving…' : 'Save for my account'}
        </button>
        {state?.ok ? (
          <p className="text-[length:var(--text-meta)] font-medium text-positive-600">
            Saved. It will follow you to your next device.
          </p>
        ) : null}
      </div>
    </form>
  );
}
