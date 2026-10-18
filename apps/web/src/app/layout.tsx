import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
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
 * Both are the variable latin subsets from @fontsource-variable (SIL Open Font
 * License 1.1), vendored under src/app/fonts so a production build needs no
 * network and no third-party request reaches a customer's browser. `display:
 * swap` and the metric fallbacks mean the page is readable before either font
 * arrives, rather than blank.
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the inline script below sets data-theme on this
    // element before React hydrates, so the DOM deliberately differs from the
    // server output. Without this React treats it as an error and re-renders
    // from the nearest boundary — which both discards the correction and causes
    // the flash the script exists to prevent.
    <html lang="en-ZA" suppressHydrationWarning className={`${inter.variable} ${manrope.variable}`}>
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
