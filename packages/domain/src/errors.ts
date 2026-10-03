/**
 * Stable, typed error contract.
 *
 * Responses carry a stable code, a human readable message and a correlation id.
 * Raw database errors and personal data never reach the client.
 */
export type DomainErrorCode =
  | 'unauthenticated'
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
    return new DomainError('validation_failed', message);
  }

  if (e?.code === '23503') return new DomainError('validation_failed', 'A referenced record does not exist in this organisation.');

  return new DomainError('internal', 'An unexpected database error occurred.');
}
