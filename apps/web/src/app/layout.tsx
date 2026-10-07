import type { Metadata, Viewport } from 'next';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

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
    <html lang="en-ZA" suppressHydrationWarning>
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
