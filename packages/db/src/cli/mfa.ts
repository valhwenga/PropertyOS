/**
 * Development-only TOTP enrolment helper.
 *
 * Elevated roles (`org_admin`, `finance_approver`, Spike platform roles) are
 * MFA-gated inside `app.has_permission`: without a verified second factor they
 * grant nothing. That is deliberate, but it means a freshly seeded database
 * looks broken — you sign in as the administrator and can see almost nothing.
 *
 * This command enrols a factor so a local preview can actually exercise those
 * paths, and can print the current code so you do not need an authenticator app
 * on hand. It is NOT an authentication bypass: the code still goes through the
 * ordinary sign-in verification, replay protection included. It exists only for
 * the local auth provider; with `AUTH_PROVIDER=supabase`, Supabase Auth owns
 * enrolment and this command has nothing to act on.
 *
 * Refuses to run when NODE_ENV=production. Printing a live second factor to a
 * terminal is a development convenience and nothing else.
 */
import postgres from 'postgres';
import { enrolmentUri, generateCode, generateSecret } from '../../../integrations/src/totp';

const USAGE = `Usage:
  pnpm db:mfa enrol <email> [--reset]   enrol a verified TOTP factor
  pnpm db:mfa code <email>              print the code valid right now
  pnpm db:mfa list                      show which accounts have a factor
`;

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run in production. Second factors are enrolled by the account ' +
        'holder, never minted by an operator command.',
    );
  }
  if (process.env.AUTH_PROVIDER === 'supabase') {
    throw new Error(
      'AUTH_PROVIDER=supabase: Supabase Auth owns enrolment. Enrol the factor ' +
        'there; this command only drives the local development provider.',
    );
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');

  const [command, email] = process.argv.slice(2);
  const reset = process.argv.includes('--reset');
  if (!command || (command !== 'list' && !email)) {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    if (command === 'list') {
      const rows = await sql<{ email: string; enrolled: boolean }[]>`
        select u.email::text as email, (f.verified_at is not null) as enrolled
        from auth.users u
        left join auth_mfa_factors f
          on f.auth_user_id = u.id and f.factor_type = 'totp'
        order by u.email
      `;
      for (const row of rows) {
        process.stdout.write(`  ${row.enrolled ? 'enrolled ' : 'none     '} ${row.email}\n`);
      }
      return;
    }

    const [user] = await sql<{ id: string }[]>`
      select id from auth.users where email = ${email!}
    `;
    if (!user) throw new Error(`No auth user with email ${email}.`);

    if (command === 'enrol') {
      const [existing] = await sql<{ secret: string }[]>`
        select secret from auth_mfa_factors
        where auth_user_id = ${user.id} and factor_type = 'totp'
      `;
      if (existing && !reset) {
        process.stdout.write(
          `${email} already has a factor. Pass --reset to replace it, or run ` +
            '`pnpm db:mfa code` for the current code.\n',
        );
        return;
      }
      const secret = generateSecret();
      // Replacing a secret invalidates the used-code log for that account: the
      // old time steps belonged to a different secret and must not block the new
      // one's codes.
      await sql.begin(async (tx) => {
        await tx`
          insert into auth_mfa_factors (auth_user_id, factor_type, secret, verified_at)
          values (${user.id}, 'totp', ${secret}, now())
          on conflict (auth_user_id, factor_type)
            do update set secret = excluded.secret, verified_at = now()
        `;
        await tx`delete from auth_mfa_used_codes where auth_user_id = ${user.id}`;
      });
      process.stdout.write(
        [
          '',
          `Enrolled a TOTP factor for ${email}.`,
          '',
          `  secret        ${secret}`,
          `  otpauth URI   ${enrolmentUri({ secret, account: email!, issuer: 'Spike PropertyOS (dev)' })}`,
          `  code now      ${generateCode(secret)}`,
          '',
          '  Add the secret to an authenticator app, or run `pnpm db:mfa code ' +
            `${email}` + '` each time you sign in. A code works once only.',
          '',
        ].join('\n'),
      );
      return;
    }

    if (command === 'code') {
      const [factor] = await sql<{ secret: string; verified_at: string | null }[]>`
        select secret, verified_at from auth_mfa_factors
        where auth_user_id = ${user.id} and factor_type = 'totp'
      `;
      if (!factor?.verified_at) {
        throw new Error(`${email} has no verified factor. Run \`pnpm db:mfa enrol ${email}\`.`);
      }
      process.stdout.write(`${generateCode(factor.secret)}\n`);
      return;
    }

    process.stdout.write(USAGE);
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
