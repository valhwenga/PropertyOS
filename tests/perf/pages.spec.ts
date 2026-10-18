import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import postgres from 'postgres';
import { generateCode } from '@propertyos/integrations';

/**
 * How long an ordinary page takes, against the blueprint's dataset.
 *
 * §26 sets targets for page data reads and asks for findings "against the
 * actual plan and dataset". Until this existed, every performance statement in
 * this repository was a guess, and the honest ones said so.
 *
 * What is measured is a real sign-in followed by real navigations, against an
 * application pointed at `propertyos_load`: the same code, the same Row Level
 * Security, the same permission resolution. Two numbers per screen:
 *
 *   TTFB     — how long the server took to begin answering. For a server-
 *              rendered page this is the data read, which is what §26 is about.
 *   content  — until something the operator came for is on the screen.
 *
 * Both are reported as a median and the slowest of the runs, because a mean
 * hides exactly the request a person would complain about.
 *
 * Generate the dataset and start an app against it first:
 *   pnpm db:loadgen
 *   APP_DATABASE_URL=...propertyos_load DATABASE_URL=...propertyos_load \
 *     pnpm --filter @propertyos/web dev -- -p 3100
 */

const PASSWORD = process.env.SEED_PASSWORD ?? 'DemoPassword123!';
const RUNS = Number(process.env.PERF_RUNS ?? 5);
const OUTPUT = process.env.PERF_OUTPUT
  ?? '/tmp/claude-0/-home-user-PropertyOS/perf-results.json';

interface Measurement { screen: string; ttfb: number[]; content: number[] }

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

async function loadFixture(): Promise<{ email: string; slug: string; leaseId: string; secret: string }> {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/propertyos_load';
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ email: string; slug: string; lease_id: string; secret: string }[]>`
      select u.email, o.slug, l.id as lease_id, f.secret
        from organisations o
        join memberships m on m.organisation_id = o.id
        join auth.users u on u.id = m.auth_user_id
        join auth_mfa_factors f on f.auth_user_id = u.id and f.verified_at is not null
        join leases l on l.organisation_id = o.id
       where o.name like '[LOAD]%'
       order by o.created_at, l.reference
       limit 1
    `;
    if (!row) throw new Error('No [LOAD] organisation with a factor found. Run pnpm db:loadgen first.');
    return { email: row.email, slug: row.slug, leaseId: row.lease_id, secret: row.secret };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test('ordinary pages, against the blueprint dataset', async ({ page }) => {
  const fixture = await loadFixture();

  // The real sign-in, second factor and all: permission resolution is MFA
  // aware and is in the path of every query being timed, so skipping it would
  // measure a session the product never issues.
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(fixture.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const code = page.getByLabel(/code/i).first();
  if (await code.isVisible({ timeout: 15_000 }).catch(() => false)) {
    await page.getByLabel('Password').fill(PASSWORD).catch(() => undefined);
    await code.fill(generateCode(fixture.secret));
    await page.getByRole('button', { name: /Verify/ }).click();
  }
  await page.waitForURL(/\/app/, { timeout: 60_000 });

  const screens: Array<{ name: string; path: string; settled: string }> = [
    { name: 'Overview', path: `/app/${fixture.slug}`, settled: 'Needs attention' },
    { name: 'Leases (page 1)', path: `/app/${fixture.slug}/leases`, settled: 'Reference' },
    { name: 'Portfolio', path: `/app/${fixture.slug}/portfolio`, settled: 'Property' },
    { name: 'Residents', path: `/app/${fixture.slug}/residents`, settled: 'Resident' },
    { name: 'Lease account (5 years)', path: `/app/${fixture.slug}/leases/${fixture.leaseId}`, settled: 'Closing receivable' },
    { name: 'Arrears report', path: `/app/${fixture.slug}/reports/arrears`, settled: 'Arrears' },
    { name: 'Collections report', path: `/app/${fixture.slug}/reports/collections`, settled: 'Collect' },
    { name: 'Reconciliation', path: `/app/${fixture.slug}/reconciliation`, settled: 'Receipt' },
    { name: 'Audit trail', path: `/app/${fixture.slug}/settings/audit`, settled: 'Audit' },
  ];

  const measurements: Measurement[] = [];

  for (const screen of screens) {
    const measurement: Measurement = { screen: screen.name, ttfb: [], content: [] };

    // One warm-up that is not recorded. The first hit of a route in a dev
    // server compiles it, which measures the bundler rather than the query.
    await page.goto(screen.path, { waitUntil: 'domcontentloaded' });
    await page.getByText(screen.settled).first().waitFor({ timeout: 120_000 }).catch(() => undefined);

    for (let run = 0; run < RUNS; run += 1) {
      const started = Date.now();
      const response = await page.goto(screen.path, { waitUntil: 'commit' });
      const timing = response?.request().timing();
      measurement.ttfb.push(
        timing && timing.responseStart > 0
          ? Math.round(timing.responseStart - timing.requestStart)
          : Date.now() - started,
      );
      await page.getByText(screen.settled).first().waitFor({ timeout: 120_000 });
      measurement.content.push(Date.now() - started);
    }

    measurements.push(measurement);
    const line = `${screen.name.padEnd(26)} TTFB median ${String(median(measurement.ttfb)).padStart(5)}ms `
      + `slowest ${String(Math.max(...measurement.ttfb)).padStart(5)}ms  |  `
      + `content median ${String(median(measurement.content)).padStart(5)}ms `
      + `slowest ${String(Math.max(...measurement.content)).padStart(5)}ms`;
    console.log(line);
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(
    OUTPUT,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        runs: RUNS,
        screens: measurements.map((m) => ({
          screen: m.screen,
          ttfbMedianMs: median(m.ttfb),
          ttfbSlowestMs: Math.max(...m.ttfb),
          contentMedianMs: median(m.content),
          contentSlowestMs: Math.max(...m.content),
        })),
      },
      null,
      2,
    ),
  );

  // Not a threshold the suite enforces — it is a measurement, and the number
  // belongs in the findings rather than in a pass or fail. The only assertion
  // is that every screen actually rendered what it was asked for, because a
  // fast page that showed nothing is not a measurement of anything.
  expect(measurements).toHaveLength(screens.length);
  for (const m of measurements) expect(m.ttfb).toHaveLength(RUNS);
});
