import { test, expect } from '@playwright/test';
import { signIn } from './sign-in';

/**
 * Every link an operator can see goes somewhere.
 *
 * This exists because three whole classes of link were dead at once and nothing
 * noticed: every property name in Portfolio and every resident name in Residents
 * answered 404, because the detail pages they pointed at had never been built,
 * and "Log a request" on Maintenance answered 500, because `/maintenance/new`
 * fell through to the ticket route, which tried to read "new" as a ticket id.
 *
 * Unit tests could not have caught any of it: each page rendered perfectly and
 * each link was perfectly well formed. Only following them finds this.
 *
 * It walks the module screens, then the detail pages it discovers from them, and
 * asks for every internal href. Anything 400 or worse fails, named.
 *
 * Requires a running preview with demo data:
 *   ./scripts/preview.sh
 */

const MODULES = [
  '', '/portfolio', '/residents', '/leases', '/applications', '/billing',
  '/reconciliation', '/deposits', '/expenses', '/maintenance', '/inspections',
  '/approvals', '/documents', '/reports', '/onboarding', '/settings',
  '/settings/landlord', '/settings/lease-templates', '/settings/support-access',
];

/** A detail page, which has links of its own worth following one level deeper. */
const DETAIL = /\/(portfolio|residents|leases|maintenance|documents|reports|settings\/lease-templates)\/[^/]+$/;

test.describe('navigation', () => {
  test.describe.configure({ timeout: 300_000 });

  // One project: whether a URL resolves is not device-specific, and a TOTP code
  // is good for exactly one sign-in, so a second project would be handed a spent
  // one and be right to fail.
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'navigation runs on one project only');
  });

  test('no operator link is broken', async ({ page }) => {
    await signIn(page, 'admin@demo.invalid');
    await page.goto('/app');
    const org = await page.locator('a[href^="/app/"]').first().getAttribute('href');
    expect(org, 'the operator sees no organisation to open').toBeTruthy();

    const status = new Map<string, number>();
    const collect = async (): Promise<string[]> =>
      page.locator('a[href]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('href') ?? '')
          // Internal only. An external link's availability is not this suite's
          // business, and asking for one from a test is rude.
          .filter((h) => h.startsWith('/')));

    const visit = async (path: string): Promise<void> => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(250);
      for (const href of new Set(await collect())) {
        if (status.has(href)) continue;
        const response = await page.request.get(href);
        status.set(href, response.status());
      }
    };

    for (const module of MODULES) await visit(`${org}${module}`);

    // The detail pages the lists just revealed. Their own links matter too: a
    // 404 one click deeper is still a 404.
    const details = [...status.entries()]
      .filter(([href, code]) => code < 400 && DETAIL.test(href))
      .map(([href]) => href);
    expect(details.length, 'no detail pages were discovered to follow').toBeGreaterThan(0);
    for (const href of details) await visit(href);

    const broken = [...status.entries()]
      .filter(([, code]) => code >= 400)
      .map(([href, code]) => `${code} ${href}`)
      .sort();
    expect(broken, `${status.size} links checked`).toEqual([]);
  });
});
