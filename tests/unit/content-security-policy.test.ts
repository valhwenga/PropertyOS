import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = readFileSync(resolve(ROOT, 'apps/web/next.config.ts'), 'utf8');

/**
 * React's development build uses eval() to rebuild stack traces, so the policy
 * has to allow it locally or every page logs a violation. It must NOT be
 * allowed in a deployed build, where eval() is never needed and permitting it
 * weakens the one header standing between a script injection and execution.
 *
 * Read from the source rather than the running server, so this holds without a
 * build and fails the moment someone makes the allowance unconditional.
 */
describe('content security policy', () => {
  it("allows eval only when the build is not production", () => {
    const line = config.split('\n').find((l) => l.includes('script-src'));
    expect(line, 'next.config.ts no longer sets script-src').toBeDefined();
    expect(line).toContain('unsafe-eval');
    // The allowance must be behind the development flag, not written in flat.
    expect(line).toMatch(/isDevelopment\s*\?/);
    expect(line).not.toMatch(/script-src[^`$]*unsafe-eval/);
  });

  it('defines the development flag from NODE_ENV', () => {
    expect(config).toMatch(/const isDevelopment = process\.env\.NODE_ENV !== 'production'/);
  });

  it('keeps the rest of the policy locked down', () => {
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "connect-src 'self'",
    ]) {
      expect(config).toContain(directive);
    }
  });

  it('serves a private document with nothing allowed at all', () => {
    const route = readFileSync(resolve(ROOT, 'apps/web/src/app/documents/object/route.ts'), 'utf8');
    expect(route).toContain("default-src 'none'; sandbox");
  });

  /**
   * The PDF preview is the one response rendered inside this origin rather than
   * handed over as a file, so it gets its own narrowed policy. It MUST live in
   * next.config.ts: a header from `headers()` wins over one set on a response,
   * so a policy set in the route handler is silently replaced by the app-wide
   * one — which is what happened the first time, and is exactly the kind of
   * protection-that-isn't this test exists to prevent.
   */
  it('narrows the policy for the inline PDF preview, in the config', () => {
    expect(config).toContain("source: '/app/:org/documents/:documentId/preview'");
    const entry = config.slice(config.indexOf('documents/:documentId/preview'));
    expect(entry).toContain("default-src 'none'");
    expect(entry).toContain("object-src 'none'");

    // Framed by this origin and no other. The app-wide headers are
    // frame-ancestors 'none' and X-Frame-Options DENY, which block framing from
    // everywhere including here — so the one response whose job is to be shown
    // inside one of our pages has to relax both, and exactly this far.
    expect(entry).toContain("frame-ancestors 'self'");
    expect(entry).toContain("key: 'X-Frame-Options', value: 'SAMEORIGIN'");

    // NOT sandbox: it puts the response in an opaque origin and the browser's
    // own PDF viewer then refuses to load, so the reader gets a blank frame
    // where their lease agreement should be. Read from the directives
    // themselves rather than the surrounding source, so the word appearing in
    // the comment that explains this does not satisfy the check.
    const directives = [...entry.slice(0, entry.indexOf('];')).matchAll(/"([^"]*)"/g)]
      .map((m) => m[1]!).join(' ');
    expect(directives).toContain("default-src 'none'");
    expect(directives).not.toContain('sandbox');

    const route = readFileSync(
      resolve(ROOT, 'apps/web/src/app/app/[org]/documents/[documentId]/preview/route.ts'),
      'utf8',
    );
    expect(route).toContain("'Content-Type': 'application/pdf'");
    expect(route).toContain("'X-Content-Type-Options': 'nosniff'");
    // Not set here, because here it would not take effect.
    expect(route).not.toMatch(/'Content-Security-Policy':/);
  });

  /**
   * Inline rendering is allowed only for bytes PropertyOS authored. An uploaded
   * file's declared content type is its uploader's claim, so a .pdf someone
   * uploaded must never reach the viewer.
   */
  it('allows inline rendering only for a PropertyOS-generated PDF', () => {
    const documents = readFileSync(resolve(ROOT, 'packages/domain/src/documents.ts'), 'utf8');
    const gate = documents.slice(documents.indexOf('params.inline'));
    expect(gate).toContain("doc.scan_status === 'system_generated'");
    expect(gate).toContain("doc.content_type === 'application/pdf'");
  });
});
