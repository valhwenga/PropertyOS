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
});
