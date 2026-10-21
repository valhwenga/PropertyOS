import postgres from 'postgres';

/**
 * Putting one corner of the demo data back to a known state.
 *
 * The browser specs run against a preview whose database is NOT reset between
 * runs, and these specs change exactly the state they then assert on: a support
 * access window left open by an earlier run makes Spike's next session arrive
 * already approved, so "waiting on the customer" never appears and the spec
 * reads as a product failure rather than as leftover state.
 *
 * Done in SQL rather than by clicking, which is the version this replaces: the
 * clicking one had to find and press a button per leftover row, and sat there
 * for fifteen minutes when a click did not change what it expected. A fixture
 * reset is not the behaviour under test, so it should not be driven through the
 * behaviour under test. `sign-in.ts` reads the TOTP secret the same way.
 */
const DB_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/propertyos_dev';

/**
 * No open support window, no live or waiting session, and an account its staff
 * can actually sign in to.
 *
 * The account status is part of this for a reason found the hard way: a run of
 * the suspension spec that was interrupted before it restored the account left
 * the demo organisation suspended, so every later run signed the landlord in,
 * was redirected to the account-suspended page as designed, and sat waiting
 * fifteen minutes for a settings page it was never going to be shown.
 */
export async function clearSupportAccess(slug: string): Promise<void> {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  try {
    const [org] = await sql<{ id: string }[]>`
      select id from organisations where slug = ${slug}
    `;
    if (!org) throw new Error(`no organisation with slug ${slug} in the preview database`);

    await sql`
      update support_sessions set revoked_at = now()
       where organisation_id = ${org.id} and revoked_at is null
    `;
    await sql`
      update support_access_grants set revoked_at = now()
       where organisation_id = ${org.id} and revoked_at is null
    `;
    await sql`
      update organisations set status = 'active'
       where id = ${org.id} and status in ('suspended', 'closed')
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
