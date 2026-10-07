/**
 * Theme choice, as pure functions.
 *
 * Kept free of React and of the DOM so the rules can be tested directly — and
 * so the inline no-flash script and the toggle cannot disagree about them.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** The localStorage key. Shared by the toggle and the inline script. */
export const THEME_STORAGE_KEY = 'propertyos-theme';

/** Anything unrecognised means "no choice recorded", not an error. */
export function parseChoice(stored: string | null | undefined): ThemeChoice {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

/**
 * Turns a choice plus the device preference into the theme to apply.
 *
 * An explicit choice always wins, so picking light on a phone set to dark is
 * honoured rather than overridden on the next page load.
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'light' || choice === 'dark') return choice;
  return prefersDark ? 'dark' : 'light';
}

/** What the toggle moves to next: a plain two-way switch from what is on screen. */
export function nextChoice(resolved: ResolvedTheme): ThemeChoice {
  return resolved === 'dark' ? 'light' : 'dark';
}

/**
 * Runs before first paint, inlined into the document head.
 *
 * Without it the page renders light and then flips, which is worse than having
 * no dark mode at all. It writes a concrete data-theme so the stylesheet needs
 * only one rule for the normal path.
 *
 * Wrapped in try/catch because localStorage throws outright in some privacy
 * modes; the page must still render, just in the system theme.
 */
export const THEME_INIT_SCRIPT = `(function(){try{
var c=localStorage.getItem('${THEME_STORAGE_KEY}');
if(c!=='light'&&c!=='dark'){c=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
document.documentElement.setAttribute('data-theme',c)
}catch(e){}})()`;
