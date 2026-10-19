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

/**
 * The cookie the server reads.
 *
 * The choice is stored against the ACCOUNT, so it follows a person to another
 * machine — but the root layout renders before any database call it could make
 * cheaply on every request, and a theme that arrives late is the flash this
 * whole module exists to avoid. So saving the choice also writes it here, and
 * the server renders `data-theme` from it directly.
 *
 * Deliberately readable by scripts: it carries a colour scheme and nothing
 * else, and the no-flash script has to be able to agree with it.
 */
export const THEME_COOKIE = 'propertyos-theme';

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
 * Three sources, in order of how specific they are to the person in front of
 * the screen: this device's own override, then what the server rendered from
 * the account's saved choice, then what the operating system asks for. The
 * middle one is why a colleague signing in on a shared machine gets their own
 * theme rather than the last person's.
 *
 * Wrapped in try/catch because localStorage throws outright in some privacy
 * modes; the page must still render, in whatever the server rendered or the
 * system asks for.
 */
export const THEME_INIT_SCRIPT = `(function(){
var d=document.documentElement,c=null;
try{c=localStorage.getItem('${THEME_STORAGE_KEY}')}catch(e){}
if(c!=='light'&&c!=='dark'){var a=d.getAttribute('data-theme');c=(a==='light'||a==='dark')?a:null}
if(c!=='light'&&c!=='dark'){try{
c=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'
}catch(e){c='light'}}
d.setAttribute('data-theme',c)
})()`;
