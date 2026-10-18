/**
 * A dataset at the blueprint's scale, so §26 can be measured rather than hoped.
 *
 *   pnpm db:loadgen                       50 organisations, 5,000 units, 60 months
 *   pnpm db:loadgen --units=500 --months=12
 *   pnpm db:loadgen --database=propertyos_load
 *
 * §26 sets targets for ordinary page reads and asks for findings "against the
 * actual plan and dataset". Nothing in this repository had ever been measured
 * against more than a handful of rows, so every performance claim was a guess.
 *
 * Two things about how this is built, because both affect what the numbers
 * mean:
 *
 *  1. **Every organisation is provisioned through the real command**, so books,
 *     accounts, roles and the administrator's membership are exactly what the
 *     product creates. Only the bulk rows beneath them are written set-based.
 *  2. **The bulk rows are written in SQL, not through the command path.** Three
 *     hundred thousand invoices cannot be posted one transaction at a time in
 *     any useful span of time. The shape is reproduced faithfully — a posted
 *     charge has a balanced journal, a receipt has one too, an allocation
 *     points at both — and the script VERIFIES that afterwards with the same
 *     invariants `scripts/restore-verify.sh` checks. A dataset that cannot
 *     satisfy them is not worth measuring against.
 *
 * Everything it creates is clearly synthetic: organisations are named
 * "[LOAD]", people use the reserved .invalid domain, and it refuses to run
 * against a database whose name does not say what it is.
 */
import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createOrganisationWithOwner } from '@propertyos/domain';
import type { Sql } from '@propertyos/db';

const scrypt = promisify(scryptCallback) as (p: string, s: Buffer, l: number) => Promise<Buffer>;

/**
 * The same password encoding the seed uses, so a load administrator can sign
 * in and the measurement is taken through the product rather than around it.
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Loads .env.local the way the other CLIs do, without overriding the shell. */
function loadLocalEnv(): void {
  if (process.env.DATABASE_URL) return;
  const envFile = fileURLToPath(new URL('../../../.env.local', import.meta.url));
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch {
    // The caller reports the missing variable, which is the accurate complaint.
  }
}

interface Options {
  organisations: number;
  units: number;
  months: number;
  database: string;
}

function parseOptions(argv: string[]): Options {
  const value = (name: string, fallback: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
  return {
    organisations: Number(value('organisations', '50')),
    units: Number(value('units', '5000')),
    months: Number(value('months', '60')),
    database: value('database', 'propertyos_load'),
  };
}

function connectionFor(database: string): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required.');
  return `${url.slice(0, url.lastIndexOf('/'))}/${database}`;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseOptions(process.argv.slice(2));

  // The one guard that matters: this writes hundreds of thousands of rows and
  // must never be pointed at a database holding somebody's records.
  if (!/load|perf|bench/.test(options.database)) {
    throw new Error(
      `Refusing to generate into "${options.database}". Name the database so it is obvious ` +
        'what is in it — propertyos_load, propertyos_perf or similar.',
    );
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run with NODE_ENV=production.');
  }

  const sql = postgres(connectionFor(options.database), { max: 1, onnotice: () => {} });
  const started = Date.now();

  const unitsPerOrganisation = Math.max(1, Math.round(options.units / options.organisations));
  const unitsPerProperty = 10;
  const propertiesPerOrganisation = Math.max(1, Math.round(unitsPerOrganisation / unitsPerProperty));

  process.stdout.write(
    `Generating ${options.organisations} organisations, about ${
      options.organisations * unitsPerOrganisation
    } units, ${options.months} months of charges, into ${options.database}.\n`,
  );

  await provision(sql, options.organisations);

  const organisations = await sql<{ id: string; book_id: string; admin: string }[]>`
    select o.id, b.id as book_id, m.auth_user_id as admin
      from organisations o
      join financial_books b on b.organisation_id = o.id and b.is_default
      join memberships m on m.organisation_id = o.id
     where o.name like '[LOAD]%'
     order by o.created_at
  `;

  let documents = 0;
  for (const [index, org] of organisations.slice(0, options.organisations).entries()) {
    await sql.begin(async (tx) => {
      await generateOrganisation(tx as unknown as typeof sql, {
        ...org,
        index,
        properties: propertiesPerOrganisation,
        unitsPerProperty,
        months: options.months,
      });
    });
    documents += unitsPerOrganisation * options.months;
    process.stdout.write(
      `  ${index + 1}/${options.organisations} filled (${documents} charge documents so far)\n`,
    );
  }

  process.stdout.write(`\nGenerated in ${Math.round((Date.now() - started) / 1000)}s.\n`);
  await verify(sql);
  await sql.end({ timeout: 10 });
}


/**
 * Provisions the organisations through the real command.
 *
 * The books, the chart of accounts, the roles and the administrator's
 * membership are then exactly what a customer gets, which is the part a
 * measurement must not fake: the permission resolution those rows drive is in
 * the path of every query being timed.
 */
async function provision(sql: ReturnType<typeof postgres>, count: number): Promise<void> {
  const [existing] = await sql<{ count: string }[]>`
    select count(*)::text from organisations where name like '[LOAD]%'
  `;
  const have = Number(existing!.count);
  if (have >= count) return;

  process.stdout.write(`Provisioning ${count - have} organisations...\n`);
  for (let i = have; i < count; i += 1) {
    const authUserId = randomUUID();
    const email = `load.admin.${i}@demo.invalid`;
    await sql`
      insert into auth.users (id, email, password_hash)
      values (${authUserId}, ${email}, ${await hashPassword(process.env.SEED_PASSWORD ?? 'DemoPassword123!')})
    `;
    await sql`
      insert into user_profiles (auth_user_id, full_name, email)
      values (${authUserId}, ${`Load Admin ${i}`}, ${email})
    `;
    await sql.begin(async (tx) => {
      await createOrganisationWithOwner(
        tx as unknown as Sql,
        {
          name: `[LOAD] Letting ${i}`,
          slug: `load-letting-${i}`,
          countryCode: 'ZA',
          currencyCode: 'ZAR',
          timeZone: 'Africa/Johannesburg',
          legalEntityName: `[LOAD] Letting ${i} (Pty) Ltd`,
          planKey: 'starter',
        },
        authUserId,
      );
    });
  }
}

interface OrganisationPlan {
  id: string;
  book_id: string;
  admin: string;
  index: number;
  properties: number;
  unitsPerProperty: number;
  months: number;
}

async function generateOrganisation(sql: ReturnType<typeof postgres>, plan: OrganisationPlan): Promise<void> {
  const { id: org, book_id: book, admin, index, properties, unitsPerProperty, months } = plan;

  // Properties and units. One portfolio already exists from provisioning.
  await sql`
    with portfolio as (
      select id from portfolios where organisation_id = ${org}::uuid order by created_at limit 1
    ),
    property as (
      insert into properties (organisation_id, portfolio_id, name, code, property_type,
        address_line1, suburb, city, province, postal_code, country_code, status)
      select ${org}::uuid, (select id from portfolio),
             '[LOAD] Block ' || p, 'L' || ${index} || '-P' || p, 'apartment_block',
             p || ' Load Street', 'Testville', 'Cape Town', 'Western Cape', '7700', 'ZA', 'active'
        from generate_series(1, ${properties}) as p
      returning id, code
    )
    insert into units (organisation_id, property_id, code, rentable_type, bedrooms, bathrooms,
      advertised_rent_minor, status)
    select ${org}::uuid, property.id, 'U' || u, 'apartment', 2, 1, 950000, 'active'
      from property, generate_series(1, ${unitsPerProperty}) as u
  `;

  // A resident per unit, and an active lease joining them.
  await sql`
    with unit as (
      select u.id as unit_id, u.property_id,
             row_number() over (order by u.property_id, u.code) as n
        from units u where u.organisation_id = ${org}::uuid
    ),
    resident as (
      insert into resident_profiles (organisation_id, first_name, last_name, email, status)
      select ${org}::uuid, 'Load', 'Resident ' || n,
             'load.' || ${index} || '.' || n || '@demo.invalid', 'active'
        from unit
      returning id, last_name
    ),
    paired as (
      select unit.unit_id, unit.property_id, unit.n, resident.id as resident_id
        from unit
        join resident on resident.last_name = 'Resident ' || unit.n
    ),
    lease as (
      insert into leases (organisation_id, property_id, unit_id, reference, status,
        start_date, rent_minor, currency_code, billing_day, deposit_required_minor,
        activated_at, activated_by, execution_exception_reason)
      select ${org}::uuid, paired.property_id, paired.unit_id,
             'LOAD-' || ${index} || '-' || lpad(paired.n::text, 5, '0'), 'active',
             date '2021-01-01', 850000, 'ZAR', 1, 850000, now(), ${admin}::uuid,
             'Synthetic load dataset.'
        from paired
      returning id, reference
    )
    insert into lease_parties (organisation_id, lease_id, resident_id, role, can_view_financials, joined_on)
    select ${org}::uuid, lease.id, paired.resident_id, 'primary_resident', true, date '2021-01-01'
      from lease
      join paired on lease.reference = 'LOAD-' || ${index} || '-' || lpad(paired.n::text, 5, '0')
  `;

  // Monthly rent: a posted charge document, its line, and a balanced journal.
  // Written as one statement per month so the server works on a set at a time
  // rather than a row at a time.
  for (let month = 0; month < months; month += 1) {
    // Identifiers are generated up front in the CTE, so every insert in the
    // statement can reference the others without RETURNING — which cannot
    // carry a window function, and so cannot pair rows after the fact.
    await sql`
      with plan as (
        select l.id as lease_id, l.property_id, l.unit_id,
               row_number() over (order by l.reference) as n,
               gen_random_uuid() as journal_id,
               gen_random_uuid() as document_id,
               gen_random_uuid() as line_id,
               (date '2021-01-01' + (${month} || ' months')::interval)::date as issue_date
          from leases l
         where l.organisation_id = ${org}::uuid and l.reference like 'LOAD-%'
      ),
      journal as (
        insert into journals (id, organisation_id, book_id, currency_code, posting_date, source,
          source_table, source_id, description, posted_by)
        select plan.journal_id, ${org}::uuid, ${book}::uuid, 'ZAR', plan.issue_date, 'rent_charge',
               'charge_documents', plan.document_id,
               'Rent ' || to_char(plan.issue_date, 'Mon YYYY'), ${admin}::uuid
          from plan
        returning id
      ),
      document as (
        insert into charge_documents (id, organisation_id, book_id, lease_id, document_type,
          document_number, status, currency_code, issue_date, due_date, period_start, period_end,
          total_minor, journal_id, created_by, posted_at, posted_by)
        select plan.document_id, ${org}::uuid, ${book}::uuid, plan.lease_id, 'rent_invoice',
               'LOADINV-' || ${month} || '-' || lpad(plan.n::text, 6, '0'), 'posted', 'ZAR',
               plan.issue_date, plan.issue_date, plan.issue_date,
               (plan.issue_date + interval '1 month - 1 day')::date,
               850000, plan.journal_id, ${admin}::uuid, now(), ${admin}::uuid
          from plan
        returning id
      ),
      line as (
        insert into charge_lines (id, organisation_id, document_id, lease_id, line_number, category,
          description, amount_minor, currency_code, income_account_id, due_date)
        select plan.line_id, ${org}::uuid, plan.document_id, plan.lease_id, 1, 'rent',
               'Monthly rent', 850000, 'ZAR',
               (select id from accounts where book_id = ${book}::uuid and system_role = 'rental_income'),
               plan.issue_date
          from plan
        returning id
      )
      insert into journal_lines (organisation_id, journal_id, account_id, debit_minor, credit_minor,
        currency_code, lease_id, line_number)
      select ${org}::uuid, plan.journal_id, account.id,
             case when account.system_role = 'resident_receivable' then 850000 else 0 end,
             case when account.system_role = 'rental_income' then 850000 else 0 end,
             'ZAR', plan.lease_id,
             case when account.system_role = 'resident_receivable' then 1 else 2 end
        from plan
        cross join (
          select id, system_role from accounts
           where book_id = ${book}::uuid and system_role in ('resident_receivable', 'rental_income')
        ) as account
    `;

    // Most months are paid: a receipt, its balanced journal, and an allocation
    // against the charge line, so the balance views have real work to do. One
    // lease in twenty does not pay, so arrears ageing has something to age.
    await sql`
      with plan as (
        select cl.id as charge_line_id, cl.lease_id,
               row_number() over (order by cl.id) as n,
               gen_random_uuid() as journal_id,
               gen_random_uuid() as receipt_id,
               (date '2021-01-01' + (${month} || ' months')::interval)::date as received_on
          from charge_lines cl
          join charge_documents cd on cd.id = cl.document_id
         where cl.organisation_id = ${org}::uuid
           and cd.document_number like 'LOADINV-' || ${month} || '-%'
           and (hashtext(cl.id::text) % 20) <> 0
      ),
      journal as (
        insert into journals (id, organisation_id, book_id, currency_code, posting_date, source,
          source_table, source_id, description, posted_by)
        select plan.journal_id, ${org}::uuid, ${book}::uuid, 'ZAR', plan.received_on, 'receipt',
               'receipts', plan.receipt_id, 'Rent received', ${admin}::uuid
          from plan
        returning id
      ),
      receipt as (
        insert into receipts (id, organisation_id, book_id, lease_id, receipt_number, status,
          amount_minor, currency_code, received_on, method, journal_id, confirmed_at, confirmed_by,
          created_by)
        select plan.receipt_id, ${org}::uuid, ${book}::uuid, plan.lease_id,
               'LOADRCT-' || ${month} || '-' || lpad(plan.n::text, 6, '0'), 'confirmed',
               850000, 'ZAR', plan.received_on, 'eft', plan.journal_id, now(), ${admin}::uuid,
               ${admin}::uuid
          from plan
        returning id
      ),
      journal_rows as (
        insert into journal_lines (organisation_id, journal_id, account_id, debit_minor,
          credit_minor, currency_code, lease_id, line_number)
        select ${org}::uuid, plan.journal_id, account.id,
               case when account.system_role = 'bank_control' then 850000 else 0 end,
               case when account.system_role = 'resident_receivable' then 850000 else 0 end,
               'ZAR', plan.lease_id,
               case when account.system_role = 'bank_control' then 1 else 2 end
          from plan
          cross join (
            select id, system_role from accounts
             where book_id = ${book}::uuid and system_role in ('bank_control', 'resident_receivable')
          ) as account
        returning id
      )
      select plan.receipt_id from plan
    `;

    // Allocations go in a statement of their own: the guard that stops an
    // allocation exceeding its receipt reads the receipt row, and a row
    // inserted by a sibling CTE is not visible to it yet. Splitting the
    // statement is how the generated data stays subject to the same guard the
    // product runs under, rather than slipping past it.
    await sql`
      insert into payment_allocations (organisation_id, receipt_id, charge_line_id, amount_minor,
        currency_code, applied_policy, allocated_by, allocated_on)
      select ${org}::uuid, r.id, cl.id, 850000, 'ZAR', 'manual', ${admin}::uuid, r.received_on
        from receipts r
        join charge_documents cd
          on cd.organisation_id = r.organisation_id and cd.lease_id = r.lease_id
         and cd.document_number like 'LOADINV-' || ${month} || '-%'
        join charge_lines cl on cl.document_id = cd.id
       where r.organisation_id = ${org}::uuid
         and r.receipt_number like 'LOADRCT-' || ${month} || '-%'
    `;
  }
}

/**
 * The same invariants the restore rehearsal checks.
 *
 * A generated dataset that cannot satisfy them is not a smaller version of
 * this product's data; it is different data, and measurements taken against it
 * would describe something the product never produces.
 */
async function verify(sql: ReturnType<typeof postgres>): Promise<void> {
  const checks: Array<[string, string]> = [
    ['every financial book balances',
      `select count(*) from (select book_id, currency_code from trial_balance
        group by book_id, currency_code having sum(net_minor) <> 0) t`],
    ['no journal is unbalanced',
      `select count(*) from (select journal_id from journal_lines
        group by journal_id having sum(signed_minor) <> 0) j`],
    ['no allocation exceeds its receipt',
      `select count(*) from (select pa.receipt_id from payment_allocations pa
         join receipts r on r.id = pa.receipt_id
        where pa.reversed_at is null
        group by pa.receipt_id having sum(pa.amount_minor) > max(r.amount_minor)) x`],
    ['no posted charge is missing its journal',
      `select count(*) from charge_documents where status <> 'draft' and journal_id is null`],
    ['every lease statement reproduces its balance',
      `select count(*) from lease_balances lb
         join lateral (select coalesce(sum(e.debit_minor - e.credit_minor), 0) as derived
                         from lease_ledger_entries e where e.lease_id = lb.lease_id) t on true
        where t.derived <> lb.receivable_minor`],
  ];

  process.stdout.write('\n=== Verification ===\n');
  let failed = false;
  for (const [label, query] of checks) {
    const [row] = await sql.unsafe<{ count: string }[]>(query);
    const ok = Number(Object.values(row ?? { count: '1' })[0]) === 0;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n`);
    if (!ok) failed = true;
  }

  const [size] = await sql<{ size: string }[]>`select pg_size_pretty(pg_database_size(current_database())) as size`;
  const counts = await sql<{ label: string; count: string }[]>`
    select 'leases' as label, count(*)::text from leases
    union all select 'charge documents', count(*)::text from charge_documents
    union all select 'charge lines', count(*)::text from charge_lines
    union all select 'receipts', count(*)::text from receipts
    union all select 'allocations', count(*)::text from payment_allocations
    union all select 'journal lines', count(*)::text from journal_lines
  `;
  process.stdout.write('\n');
  for (const row of counts) process.stdout.write(`      ${row.label.padEnd(20)} ${row.count}\n`);
  process.stdout.write(`      ${'database size'.padEnd(20)} ${size!.size}\n`);

  if (failed) {
    process.stdout.write('\nThe generated data does not satisfy the product’s own invariants.\n');
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
