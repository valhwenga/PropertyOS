import type { NextConfig } from 'next';

const isDevelopment = process.env.NODE_ENV !== 'production';

const config: NextConfig = {
  reactStrictMode: true,
  // The domain and db packages are workspace TypeScript sources.
  transpilePackages: ['@propertyos/ui', '@propertyos/domain', '@propertyos/db', '@propertyos/integrations'],
  serverExternalPackages: ['postgres'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next's inline bootstrap requires 'unsafe-inline' for styles;
              // scripts are restricted to self plus Next's nonce-less inline
              // hydration payload, which is why 'unsafe-inline' is present here
              // too. Tightening this to a nonce-based policy is tracked in
              // docs/known-limitations.md.
              //
              // 'unsafe-eval' is added in DEVELOPMENT ONLY. React's development
              // build uses eval() to rebuild stack traces across environments,
              // so without it every page logged a Content-Security-Policy error
              // and the dev overlay reported an issue on a page that was fine.
              // React never uses eval() in its production build, so the
              // deployed policy stays strict — which is the whole point of
              // having one.
              `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ''}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default config;
