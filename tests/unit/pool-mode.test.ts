import { describe, expect, it, afterEach } from 'vitest';

import { usesTransactionPooler } from '@propertyos/db';

// Whether a connection goes through a transaction-mode pooler decides whether
// prepared statements are usable, and the symptom of getting it wrong is an
// intermittent "prepared statement already exists" under load rather than
// anything that happens on the first query. So the detection is tested rather
// than trusted.
describe('transaction pooler detection', () => {
  afterEach(() => {
    delete process.env.DATABASE_POOL_MODE;
  });

  it('treats a plain local connection as a direct one', () => {
    expect(usesTransactionPooler('postgresql://app:pw@localhost:5432/propertyos_dev')).toBe(false);
  });

  it('recognises the pooler by its port', () => {
    expect(usesTransactionPooler('postgresql://app:pw@db.example.supabase.co:6543/postgres')).toBe(true);
  });

  it('recognises the pooler by its host', () => {
    expect(usesTransactionPooler('postgresql://app:pw@ep-cold-sun-pooler.eu-central-1.aws.neon.tech/main')).toBe(true);
  });

  it('recognises the pgbouncer flag whatever the port', () => {
    expect(usesTransactionPooler('postgresql://app:pw@host:5432/db?pgbouncer=true')).toBe(true);
    expect(usesTransactionPooler('postgresql://app:pw@host:5432/db?sslmode=require&pgbouncer=true')).toBe(true);
  });

  it('lets the environment override the guess in both directions', () => {
    process.env.DATABASE_POOL_MODE = 'transaction';
    expect(usesTransactionPooler('postgresql://app:pw@localhost:5432/propertyos_dev')).toBe(true);
    process.env.DATABASE_POOL_MODE = 'session';
    expect(usesTransactionPooler('postgresql://app:pw@db.example.supabase.co:6543/postgres')).toBe(false);
  });
});
