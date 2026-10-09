/**
 * Stable, typed error contract.
 *
 * Responses carry a stable code, a human readable message and a correlation id.
 * Raw database errors and personal data never reach the client.
 */
export type DomainErrorCode =
  | 'unauthenticated'
  | 'reauthentication_required'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'stale_version'
  | 'period_locked'
  | 'immutable_record'
  | 'over_allocation'
  | 'duplicate'
  | 'unsupported'
  | 'internal';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
    this.httpStatus = HTTP_STATUS[code];
  }
}

const HTTP_STATUS: Record<DomainErrorCode, number> = {
  unauthenticated: 401,
  // 401, not 403: the caller is permitted, they just have to prove it is still
  // them. A 403 would tell the interface to say "you do not have access", which
  // is both wrong and unhelpful.
  reauthentication_required: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  stale_version: 409,
  period_locked: 409,
  immutable_record: 409,
  over_allocation: 409,
  duplicate: 409,
  unsupported: 400,
  internal: 500,
};

export const forbidden = (message = 'You do not have access to this record.') =>
  new DomainError('forbidden', message);
export const notFound = (what = 'Record') => new DomainError('not_found', `${what} not found.`);
export const invalid = (message: string, details?: Record<string, unknown>) =>
  new DomainError('validation_failed', message, details);
export const conflict = (message: string) => new DomainError('conflict', message);

/**
 * Validates with a schema and reports failures as a domain error.
 *
 * Calling `.parse` directly leaks a ZodError out of the domain. The web layer
 * happens to translate that, but the worker and any other caller do not, so the
 * domain's error contract would depend on who called it. This keeps the
 * contract the same for everyone, and keeps the field paths, which are what an
 * interface needs to mark the offending input.
 */
export function parsed<T>(
  schema: { parse: (value: unknown) => T },
  value: unknown,
  message = 'Some of those details are not valid.',
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    const issues = (error as { issues?: { path: (string | number)[]; message: string }[] }).issues;
    if (!issues) throw error;
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of issues) {
      const key = issue.path.join('.') || '_';
      (fieldErrors[key] ??= []).push(issue.message);
    }
    // One issue reads better as itself than as a generic sentence with a
    // field list nobody opens.
    const summary = issues.length === 1 ? issues[0]!.message : message;
    throw new DomainError('validation_failed', summary, { fieldErrors });
  }
}

/**
 * Translates a PostgreSQL error into a domain error.
 *
 * The database is the final authority on financial invariants, so a constraint
 * violation is a legitimate, expected outcome that must surface as a readable
 * message rather than a 500.
 */
export function fromDatabaseError(error: unknown): DomainError {
  const e = error as { code?: string; constraint_name?: string; message?: string; detail?: string };
  const message = e?.message ?? 'Database error';

  if (e?.code === '23505') {
    if (e.constraint_name === 'charge_documents_no_duplicate_period') {
      return new DomainError(
        'duplicate',
        'A charge for this schedule and billing period already exists. The run was not duplicated.',
      );
    }
    if (e.constraint_name === 'bank_transactions_external_unique' ||
        e.constraint_name === 'bank_transactions_fingerprint_unique') {
      return new DomainError('duplicate', 'This bank transaction has already been imported.');
    }
    if (e.constraint_name === 'bank_imports_same_file') {
      return new DomainError('duplicate', 'This exact statement file has already been imported.');
    }
    return new DomainError('duplicate', 'A record with these details already exists.');
  }

  if (e?.code === '23P01') {
    if (e.constraint_name === 'leases_no_overlapping_reservation') {
      return new DomainError(
        'conflict',
        'This unit already has a lease reserving an overlapping period. Only one exclusive lease can hold a unit at a time.',
      );
    }
    if (e.constraint_name === 'occupancy_intervals_unit_id_period_excl') {
      return new DomainError('conflict', 'This unit is already recorded as occupied for an overlapping period.');
    }
    return new DomainError('conflict', 'This record overlaps an existing period.');
  }

  if (e?.code === '42501') {
    if (message.includes('locked')) return new DomainError('period_locked', message);
    if (message.includes('immutable')) return new DomainError('immutable_record', message);
    return new DomainError('forbidden', message);
  }

  if (e?.code === '23514') {
    if (message.includes('exceeds receipt')) return new DomainError('over_allocation', message);
    if (message.includes('exceeds charge line')) return new DomainError('over_allocation', message);
    if (message.includes('does not balance')) return new DomainError('internal', message);
    // Raised when billing a past period with today's date: the invoices carry
    // due dates inside that month, and a charge cannot be issued after it
    // falls due. The raw constraint name tells an operator nothing.
    if (e.constraint_name === 'charge_documents_dates') {
      return new DomainError(
        'validation_failed',
        'A charge cannot be issued after the date it falls due. When billing a past period, '
          + 'date the invoices within that period rather than today.',
      );
    }
    return new DomainError('validation_failed', message);
  }

  if (e?.code === '23503') return new DomainError('validation_failed', 'A referenced record does not exist in this organisation.');

  return new DomainError('internal', 'An unexpected database error occurred.');
}
