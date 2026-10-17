import type { NextConfig } from 'next';

const isDevelopment = process.env.NODE_ENV !== 'production';

const config: NextConfig = {
  reactStrictMode: true,
  // The domain and db packages are workspace TypeScript sources.
  transpilePackages: ['@propertyos/ui', '@propertyos/domain', '@propertyos/db', '@propertyos/integrations'],
  serverExternalPackages: ['postgres'],
  experimental: {
    serverActions: {
      // Every upload in this product — a scanned lease, a resident's proof of
      // payment, a photograph of a burst geyser, a portfolio CSV — arrives
      // through a Server Action, and Next caps an action's request body at 1 MB
      // by default. The product advertises 25 MB for a document and 5 MB for an
      // import, and checks both itself with a message that says what to do; but
      // the framework rejected the request first, so a 1.6 MB spreadsheet got
      // "A server error occurred" and an operator had no idea why. The limit is
      // raised past the largest file the product accepts, plus room for
      // multipart overhead, so that OUR limits are the ones that answer.
      //
      // The cost is that any action, including the anonymous ones, will now
      // buffer a body this large before our code runs. That is the same
      // exposure any endpoint accepting 25 MB uploads carries, and it is noted
      // in docs/known-limitations.md rather than papered over.
      bodySizeLimit: '26mb',
    },
  },
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
      {
        // A PropertyOS-generated PDF, served to be read on the page. It needs
        // none of the capabilities the app-wide policy grants, so it gets none:
        // this entry comes after the catch-all so that its Content-Security-Policy
        // replaces the broader one for this path only.
        //
        // Setting it in the route handler does not work — a header from
        // `headers()` wins over one set on the response — so it has to be here,
        // next to the policy it is narrowing.
        source: '/app/:org/documents/:documentId/preview',
        headers: [
          {
            key: 'Content-Security-Policy',
            // No `sandbox`: it puts the response in an opaque origin, which
            // stops the browser's OWN PDF viewer from loading, so the reader
            // gets a blank frame instead of their agreement.
            value: "default-src 'none'; object-src 'none'; img-src 'self' blob:; "
              + "frame-ancestors 'self'",
          },
          // The app-wide header is DENY, which blocks framing from ANY origin —
          // this origin included. That is right for the app's own pages and
          // wrong for the one response whose entire job is to be shown inside
          // one of them: with DENY in place the viewer rendered its "your
          // browser will not display a PDF" fallback, which read exactly like a
          // browser that could not.
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
    ];
  },
};

export default config;
