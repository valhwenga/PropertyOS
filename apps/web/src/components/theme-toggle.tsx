'use client';

import { useEffect, useState, useTransition } from 'react';
import { saveThemeAction } from '@/app/account/actions';
import {
  nextChoice, parseChoice, resolveTheme, THEME_STORAGE_KEY,
  type ResolvedTheme,
} from '@/lib/theme';

/**
 * Switches between light and dark, and remembers the choice on this device.
 *
 * The theme is already on the page before React runs — the inline script in the
 * root layout sets it — so this reads what is actually applied rather than
 * guessing, which is what keeps the first render from disagreeing with the
 * screen.
 *
 * The choice applies immediately on this device and is then saved against the
 * account, so it follows the person to their next machine. The save is not
 * awaited: a colour scheme must not wait on a round trip, and if the request
 * fails the device still looks the way the reader just asked for.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const [, save] = useTransition();
  // Null until mounted. The server cannot know the device's theme, so rendering
  // a definite icon here would be a guess that flips after hydration.
  const [theme, setTheme] = useState<ResolvedTheme | null>(null);

  useEffect(() => {
    const applied = document.documentElement.getAttribute('data-theme');
    if (applied === 'dark' || applied === 'light') {
      setTheme(applied);
      return;
    }
    setTheme(resolveTheme(
      parseChoice(null),
      window.matchMedia('(prefers-color-scheme: dark)').matches,
    ));
  }, []);

  function toggle() {
    const current = theme ?? 'light';
    const choice = nextChoice(current);
    const resolved = choice === 'system' ? current : choice;
    document.documentElement.setAttribute('data-theme', resolved);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, resolved);
    } catch {
      // A privacy mode can refuse storage. The theme still applies for this
      // page; it simply will not be remembered, which is better than failing.
    }
    setTheme(resolved);

    // Saved for the account too. A signed-out page has nobody to save it
    // against, and the action simply refuses — which is why nothing here
    // depends on the result.
    const form = new FormData();
    form.set('theme', resolved);
    save(() => { void saveThemeAction(null, form); });
  }

  const label = theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={[
        'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ink-200',
        'text-ink-700 hover:bg-ink-50',
        className,
      ].join(' ')}
    >
      {/* aria-hidden: the button's own label carries the meaning. Until the
          theme is known the glyph is blank rather than wrong. */}
      <span aria-hidden="true" className="text-sm leading-none">
        {theme === null ? '' : theme === 'dark' ? '☀' : '☾'}
      </span>
    </button>
  );
}
