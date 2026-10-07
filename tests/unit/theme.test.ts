/**
 * The theme rules, and the one thing about the stylesheet that can rot quietly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  nextChoice, parseChoice, resolveTheme, THEME_INIT_SCRIPT, THEME_STORAGE_KEY,
} from '../../apps/web/src/lib/theme';

describe('theme choice', () => {
  it('treats anything unrecognised as no choice recorded', () => {
    for (const stored of [null, undefined, '', 'DARK', 'auto', 'true', '{}']) {
      expect(parseChoice(stored), String(stored)).toBe('system');
    }
    expect(parseChoice('light')).toBe('light');
    expect(parseChoice('dark')).toBe('dark');
  });

  it('lets an explicit choice beat the device preference, in both directions', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the device when no choice has been made', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('toggles against what is on screen, not against what is stored', () => {
    // Someone on a dark device who has never chosen sees dark; the switch must
    // take them to light, not to a stored value they never set.
    expect(nextChoice(resolveTheme('system', true))).toBe('light');
    expect(nextChoice(resolveTheme('system', false))).toBe('dark');
  });
});

describe('the inline no-flash script', () => {
  it('uses the same storage key as the toggle', () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_STORAGE_KEY);
  });

  it('cannot break the page when storage throws', () => {
    expect(THEME_INIT_SCRIPT).toContain('try');
    expect(THEME_INIT_SCRIPT).toContain('catch');
  });

  it('agrees with resolveTheme when run', () => {
    // Executed for real against a stubbed document and storage, so the script
    // and the pure rule cannot drift apart.
    const run = (stored: string | null, prefersDark: boolean) => {
      let written: string | null = null;
      const sandbox = {
        localStorage: { getItem: () => stored },
        document: { documentElement: { setAttribute: (_k: string, v: string) => { written = v; } } },
        window: { matchMedia: () => ({ matches: prefersDark }) },
      };
      new Function('localStorage', 'document', 'window', THEME_INIT_SCRIPT)(
        sandbox.localStorage, sandbox.document, sandbox.window,
      );
      return written;
    };
    for (const [stored, prefersDark] of [
      ['dark', false], ['light', true], [null, true], [null, false], ['nonsense', true],
    ] as const) {
      expect(run(stored, prefersDark), `${stored}/${prefersDark}`)
        .toBe(resolveTheme(parseChoice(stored), prefersDark));
    }
  });

  it('survives storage that throws outright', () => {
    let written: string | null = null;
    const throwing = { getItem: () => { throw new Error('denied'); } };
    expect(() => new Function('localStorage', 'document', 'window', THEME_INIT_SCRIPT)(
      throwing,
      { documentElement: { setAttribute: (_k: string, v: string) => { written = v; } } },
      { matchMedia: () => ({ matches: true }) },
    )).not.toThrow();
    expect(written).toBeNull();
  });
});

describe('the dark palette in the stylesheet', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../../packages/ui/src/styles.css', import.meta.url)),
    'utf8',
  );

  /** The declarations inside a rule, normalised for comparison. */
  function declarations(afterSelector: string): string[] {
    const start = css.indexOf(afterSelector);
    expect(start, `${afterSelector} should exist`).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    const body = css.slice(open + 1, css.indexOf('}', open));
    return body.split(';').map((d) => d.trim()).filter(Boolean).sort();
  }

  it('states the same palette for the chosen theme and the system fallback', () => {
    // The two rules exist because the inline script cannot run before itself or
    // without JavaScript. If they drift, one group of users gets a half theme.
    expect(declarations(":root[data-theme='dark']"))
      .toEqual(declarations(':root:not([data-theme])'));
  });

  it('leaves the brand purple alone, so the primary button keeps its white label', () => {
    expect(declarations(":root[data-theme='dark']").join(';'))
      .not.toContain('--color-spike-500');
  });

  it('re-points every token the light theme defines as a near-white surface', () => {
    const dark = declarations(":root[data-theme='dark']").join(';');
    for (const token of [
      '--color-surface', '--color-ink-50', '--color-ink-100', '--color-ink-200',
      '--color-ink-500', '--color-ink-700', '--color-ink-900',
    ]) {
      expect(dark, `${token} must be restated in dark`).toContain(token);
    }
  });
});
