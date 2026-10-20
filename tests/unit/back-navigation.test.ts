/**
 * Every page you can open from a list must say how to get back.
 *
 * The console has a sidebar, which answers "where else can I go" and not
 * "where did I come from". A lease, a ticket, a report or a settings page
 * replaces the list that led to it, and several of them had no way back at all
 * — the browser's own button, or the sidebar and then the list again.
 *
 * The rule, stated as a route depth: a page one segment below the organisation
 * IS a section, reachable from the sidebar, and needs nothing. Anything deeper
 * was opened from somewhere, and carries a BackLink to it.
 *
 * This is a static check on purpose. A browser test can only visit the pages
 * somebody remembered to list; the filesystem knows all of them, including the
 * one added next week.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const CONSOLE = join(process.cwd(), 'apps/web/src/app/app/[org]');

function pages(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...pages(path));
    else if (entry === 'page.tsx') found.push(path);
  }
  return found;
}

/** The route segments below the organisation, e.g. ['settings', 'appearance']. */
function segments(path: string): string[] {
  return relative(CONSOLE, path).split(sep).slice(0, -1).filter(Boolean);
}

describe('getting back out of a page', () => {
  const all = pages(CONSOLE);

  it('finds the console pages at all', () => {
    // A rename that silently emptied this list would make every assertion
    // below pass while checking nothing.
    expect(all.length).toBeGreaterThan(25);
  });

  it('gives every page below a section a way back to it', () => {
    const missing = all
      .filter((path) => segments(path).length >= 2)
      .filter((path) => !readFileSync(path, 'utf8').includes('BackLink'))
      .map((path) => `/${segments(path).join('/')}`);

    expect(missing, 'these pages replace the list that opened them').toEqual([]);
  });

  it('does not put one on a section the sidebar already reaches', () => {
    // A back link on Leases or Settings would point at the overview, which is
    // not where anybody came from. Noise, and wrong.
    const spurious = all
      .filter((path) => segments(path).length <= 1)
      .filter((path) => readFileSync(path, 'utf8').includes('BackLink'))
      .map((path) => `/${segments(path).join('/')}`);

    expect(spurious).toEqual([]);
  });

  it('uses the shared component rather than another hand-written arrow', () => {
    // Three different arrows in three different places is how an interface
    // starts looking assembled rather than designed.
    const handmade = all
      .filter((path) => /←|&larr;/.test(readFileSync(path, 'utf8')))
      .map((path) => `/${segments(path).join('/')}`);

    expect(handmade).toEqual([]);
  });
});
