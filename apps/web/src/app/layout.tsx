import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cookies } from 'next/headers';
import { THEME_COOKIE, THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

/**
 * Two typefaces, served from this application rather than from anybody else's.
 *
 * Inter carries the interface — navigation, forms, tables, every figure. Its
 * tabular numerals are what make a column of money line up on the decimal
 * point, which is the reason this product used a monospace font before and no
 * longer needs to.
 *
 * Manrope carries headings and headline metrics. A second typeface is the
 * cheapest way to make "this is the page" and "this is a field label" read as
 * different things at a glance.
 *
 * Source Sans 3 and Fraunces are here for the same reason, one step removed:
 * an organisation can choose them in Settings → Appearance, and a font a
 * landlord picked must be served from this application like the others. A
 * family that nobody has chosen costs nothing to declare — a browser fetches
 * a font file only when a rule actually applies it to text on the page.
 *
 * All four are the variable latin subsets from @fontsource-variable (SIL Open
 * Font License 1.1), vendored under src/app/fonts so a production build needs
 * no network and no third-party request reaches a customer's browser.
 * `display: swap` and the metric fallbacks mean the page is readable before
 * any of them arrives, rather than blank.
 */
const inter = localFont({
  src: './fonts/inter-variable.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-sans-loaded',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  adjustFontFallback: 'Arial',
});

const manrope = localFont({
  src: './fonts/manrope-variable.woff2',
  weight: '200 800',
  display: 'swap',
  variable: '--font-display-loaded',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  adjustFontFallback: 'Arial',
});

const sourceSans = localFont({
  src: './fonts/source-sans-3-variable.woff2',
  weight: '200 900',
  display: 'swap',
  variable: '--font-humanist-loaded',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
  adjustFontFallback: 'Arial',
});

const fraunces = localFont({
  src: './fonts/fraunces-variable.woff2',
  weight: '100 900',
  display: 'swap',
  variable: '--font-humanist-display-loaded',
  fallback: ['ui-serif', 'Georgia', 'Times New Roman', 'serif'],
  adjustFontFallback: 'Times New Roman',
});

export const metadata: Metadata = {
  title: { default: 'Spike PropertyOS', template: '%s · Spike PropertyOS' },
  description: 'Rental property management for South African landlords.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#5F33FF',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The account's own choice, written here as an attribute so the first paint
  // is already the right colour on a machine this person has never used. The
  // inline script below still runs: a device override beats this, and a reader
  // with neither falls back to what their operating system asks for.
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = saved === 'light' || saved === 'dark' ? saved : undefined;

  return (
    // suppressHydrationWarning: the inline script below sets data-theme on this
    // element before React hydrates, so the DOM deliberately differs from the
    // server output. Without this React treats it as an error and re-renders
    // from the nearest boundary — which both discards the correction and causes
    // the flash the script exists to prevent.
    <html lang="en-ZA" suppressHydrationWarning data-theme={theme} className={
        `${inter.variable} ${manrope.variable} ${sourceSans.variable} ${fraunces.variable}`
      }>
      <head>
        {/* Applies the stored theme before the first paint. Rendering light and
            then flipping to dark is worse than not offering dark at all, and
            that flash is only avoidable from a blocking inline script. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a href="#main" className="skip-link">Skip to main content</a>
        {children}
      </body>
    </html>
  );
}
