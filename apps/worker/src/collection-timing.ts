/**
 * Times the collection metrics against the load dataset, under real RLS.
 *
 * `pnpm perf` measures whole pages through a browser, which is the right
 * number to publish and the wrong one to iterate on: a rebuild of a Next route
 * costs more than the query being fixed. This runs the same two functions the
 * overview and the collection report call, through `withActor`, so the policies
 * and the permission resolution are the ones production would use.
 *
 *   DATABASE_URL=...propertyos_load APP_DATABASE_URL=...propertyos_load \
 *     pnpm --filter @propertyos/worker exec tsx src/collection-timing.ts
 */
import { withActor } from '@propertyos/db';
import { collectionByLease, collectionTotals } from '@propertyos/domain';
import postgres from 'postgres';

const RUNS = Number(process.env.TIMING_RUNS ?? 5);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  const owner = postgres(url, { max: 1, onnotice: () => {} });

  const [fixture] = await owner<
    { organisation_id: string; auth_user_id: string; period_start: string; period_end: string }[]
  >`
    select o.id as organisation_id, m.auth_user_id,
           date_trunc('month', max(cd.period_start))::date::text as period_start,
           (date_trunc('month', max(cd.period_start)) + interval '1 month - 1 day')
             ::date::text as period_end
      from organisations o
      join memberships m on m.organisation_id = o.id and m.status = 'active'
      join charge_documents cd on cd.organisation_id = o.id
     where o.name like '[LOAD]%'
     group by o.id, m.auth_user_id
     order by o.created_at
     limit 1
  `;
  await owner.end();
  if (!fixture) throw new Error('No [LOAD] organisation found. Run pnpm db:loadgen first.');

  const scope = { periodStart: fixture.period_start, periodEnd: fixture.period_end };
  console.log(`organisation ${fixture.organisation_id}`);
  console.log(`period ${scope.periodStart} to ${scope.periodEnd}\n`);

  const actor = { authUserId: fixture.auth_user_id, assuranceLevel: 'aal2' as const };
  const timings: Record<string, number[]> = { totals: [], byLease: [] };

  for (let run = 0; run < RUNS; run += 1) {
    await withActor(actor, async ({ tx }) => {
      let started = performance.now();
      const totals = await collectionTotals(tx, fixture.organisation_id, scope);
      timings.totals!.push(Math.round(performance.now() - started));

      started = performance.now();
      const rows = await collectionByLease(tx, fixture.organisation_id, scope);
      timings.byLease!.push(Math.round(performance.now() - started));

      if (run === 0) {
        console.log(`  billed ${totals.total.billedMinor}  collected ${totals.total.collectedMinor}`
          + `  rate ${totals.total.ratePercent}  rows ${rows.length}`);
      }
    });
  }

  for (const [name, values] of Object.entries(timings)) {
    console.log(`${name.padEnd(10)} median ${median(values)}ms  slowest ${Math.max(...values)}ms`
      + `  (${values.join(', ')})`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
