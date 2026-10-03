/**
 * Database connection configuration.
 *
 * Two distinct connections exist, and the difference is a security boundary:
 *
 *  - `DATABASE_URL` is the privileged/owner connection. It is used ONLY to run
 *    migrations and to claim durable jobs. It must never serve a web request.
 *  - `APP_DATABASE_URL` connects as a login role that is a member of
 *    `propertyos_app`: not a superuser, not the table owner, and without
 *    BYPASSRLS. Every request-scoped query runs through it so that Row Level
 *    Security is always in force.
 *
 * If `APP_DATABASE_URL` is absent we do NOT silently fall back to the privileged
 * connection, because that would turn an environment misconfiguration into a
 * total loss of tenant isolation. We fail loudly instead.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `See .env.example. PropertyOS refuses to start without an explicit, ` +
        `RLS-enforced application database connection.`,
    );
  }
  return value;
}

export function privilegedDatabaseUrl(): string {
  return required('DATABASE_URL');
}

export function appDatabaseUrl(): string {
  return required('APP_DATABASE_URL');
}

export const isProduction = process.env.NODE_ENV === 'production';
