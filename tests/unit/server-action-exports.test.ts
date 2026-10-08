/**
 * Every export of a `'use server'` file must be an async function.
 *
 * This exists because of a real outage in development. A synchronous helper was
 * exported from a `'use server'` module — it compiled, it type-checked, it
 * linted, and `pnpm test` was green. The application then returned 500 for
 * EVERY route, including sign-in, because the broken module was imported by a
 * page and the error surfaced at module evaluation rather than at the call.
 *
 * Nothing in the toolchain catches it: the rule belongs to Next.js, not to
 * TypeScript. So it is checked here, by reading the files, which is cheap and
 * finds it before a browser does.
 *
 * Type-only exports are erased before the rule applies and are allowed.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../../apps/web/src', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Files whose first statement is the 'use server' directive. */
function serverActionFiles(): { path: string; source: string }[] {
  return walk(WEB)
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => /^\s*(['"])use server\1\s*;?/.test(source));
}

/**
 * Exported value declarations, with whether they are async functions.
 *
 * Deliberately a regular expression over source rather than a parse: the rule
 * is simple, the file set is small, and a false positive here is a loud test
 * failure rather than a silent escape.
 */
function offendingExports(source: string): string[] {
  const offenders: string[] = [];

  // export function foo / export const foo = ...
  const re = /^export\s+(?!type\b|interface\b|default\b)(async\s+function|function|const|let|var|class)\s+([A-Za-z0-9_$]+)/gm;
  for (const match of source.matchAll(re)) {
    const [, kind, name] = match;
    if (kind === 'async function') continue;
    if (kind === 'const') {
      // An exported const is fine only if it is an async arrow or an async
      // function expression.
      const decl = source.slice(match.index!, match.index! + 400);
      if (/=\s*async\s*(\(|function)/.test(decl)) continue;
    }
    offenders.push(`${kind} ${name}`);
  }

  // export { a, b } — re-exporting a local helper is the same mistake.
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    const names = match[1]!
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith('type '));
    for (const name of names) offenders.push(`re-export ${name}`);
  }

  return offenders;
}

describe("'use server' files", () => {
  const files = serverActionFiles();

  it('exist, so this test is actually checking something', () => {
    // A refactor that moved every action would otherwise make this suite pass
    // by examining nothing at all.
    expect(files.length).toBeGreaterThan(5);
  });

  it('export only async functions', () => {
    const problems = files
      .map(({ path, source }) => ({ path, offenders: offendingExports(source) }))
      .filter(({ offenders }) => offenders.length > 0)
      .map(({ path, offenders }) => `${path.replace(WEB, 'apps/web/src')}: ${offenders.join(', ')}`);

    expect(
      problems,
      'A non-async export from a "use server" file makes every route importing it return 500. '
        + 'Move the helper into its own module.',
    ).toEqual([]);
  });
});

describe('returnTo is not an open redirect', () => {
  it('refuses anything that is not a path inside this application', async () => {
    const { safeReturnTo } = await import(
      '../../apps/web/src/app/reauthenticate/return-to.js'
    );
    // The protocol-relative form is the one naive checks let through: it starts
    // with a slash and is not a path.
    expect(safeReturnTo('//evil.example/phish')).toBe('/app');
    expect(safeReturnTo('https://evil.example')).toBe('/app');
    expect(safeReturnTo('/\\evil.example')).toBe('/app');
    expect(safeReturnTo('')).toBe('/app');
    expect(safeReturnTo(null)).toBe('/app');
    expect(safeReturnTo(undefined)).toBe('/app');
  });

  it('keeps an ordinary internal path', async () => {
    const { safeReturnTo } = await import(
      '../../apps/web/src/app/reauthenticate/return-to.js'
    );
    expect(safeReturnTo('/app/demo/settings/banking')).toBe('/app/demo/settings/banking');
    expect(safeReturnTo('/reauthenticate?x=1')).toBe('/app');
  });
});
