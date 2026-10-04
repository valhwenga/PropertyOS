import { NextResponse } from 'next/server';
import { sql, assertApplicationRoleIsIsolated } from '@propertyos/db';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness probe.
 *
 * Deliberately exposes NO customer data and no counts that could leak scale to
 * an unauthenticated caller. It answers one question: can this instance serve
 * traffic safely?
 *
 * The isolation self-check is part of "safely". An instance whose database role
 * could bypass Row Level Security reports unhealthy and is taken out of the
 * load balancer, rather than silently serving every tenant's data to everyone.
 */
export async function GET() {
  const started = Date.now();
  const checks: Record<string, 'ok' | 'failed'> = {};
  let healthy = true;

  try {
    await sql()`select 1`;
    checks.database = 'ok';
  } catch {
    checks.database = 'failed';
    healthy = false;
  }

  try {
    await assertApplicationRoleIsIsolated();
    checks.tenantIsolation = 'ok';
  } catch {
    checks.tenantIsolation = 'failed';
    healthy = false;
  }

  return NextResponse.json(
    {
      status: healthy ? 'healthy' : 'unhealthy',
      checks,
      durationMs: Date.now() - started,
      // Correlates a deploy with an incident; not sensitive.
      revision: process.env.APP_REVISION ?? 'unknown',
    },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
