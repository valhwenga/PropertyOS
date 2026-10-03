/**
 * Migration runner.
 *
 * Migrations are plain, reviewed SQL files applied in filename order inside a
 * transaction each, with a checksum recorded. A file that changed after being
 * applied is a hard error: reproducing the schema from an empty database is a
 * release requirement, so silent drift is not tolerated.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations.');
  const reset = process.argv.includes('--reset');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    if (reset) {
      if (process.env.NODE_ENV === 'production' || process.env.ALLOW_DESTRUCTIVE !== 'true') {
        throw new Error(
          '--reset drops every table. Set ALLOW_DESTRUCTIVE=true and ensure NODE_ENV is not production.',
        );
      }
      process.stdout.write('Dropping schemas public and app...\n');
      await sql.unsafe('drop schema if exists public cascade; create schema public;');
      await sql.unsafe('drop schema if exists app cascade;');
    }

    await sql.unsafe(`
      create table if not exists schema_migrations (
        filename text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Map<string, string>();
    for (const row of await sql<{ filename: string; checksum: string }[]>`
      select filename, checksum from schema_migrations
    `) {
      applied.set(row.filename, row.checksum);
    }

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    let appliedCount = 0;

    for (const file of files) {
      const body = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} has changed since it was applied ` +
              `(recorded ${previous.slice(0, 12)}, now ${checksum.slice(0, 12)}). ` +
              `Add a new migration instead of editing an applied one.`,
          );
        }
        continue;
      }

      process.stdout.write(`applying ${file} ... `);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`
          insert into schema_migrations (filename, checksum) values (${file}, ${checksum})
        `;
      });
      process.stdout.write('ok\n');
      appliedCount += 1;
    }

    process.stdout.write(
      appliedCount === 0
        ? 'Database is up to date.\n'
        : `Applied ${appliedCount} migration(s).\n`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
