import type { Sql } from '@propertyos/db';

const REDACTED = '[redacted]';
/** Never written to the audit trail or to logs. */
const SENSITIVE_KEYS = new Set([
  'password', 'password_hash', 'token', 'invite_token', 'invite_token_hash',
  'identity_number', 'id_number', 'account_number', 'bank_account_number',
  'secret', 'authorization', 'cookie', 'storage_key', 'signed_url',
]);

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v);
    }
    return out;
  }
  return value;
}

export interface AuditInput {
  organisationId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  correlationId?: string | null;
  supportSessionId?: string | null;
}

/**
 * Writes an audit event in the SAME transaction as the change it describes, so
 * an action can never be committed without its audit record.
 */
export async function recordAudit(tx: Sql, input: AuditInput): Promise<void> {
  await tx`
    insert into audit_events (
      organisation_id, actor_user_id, action, resource_type, resource_id,
      reason, before_state, after_state, correlation_id, support_session_id
    ) values (
      ${input.organisationId}, ${input.actorUserId}, ${input.action},
      ${input.resourceType}, ${input.resourceId ?? null}, ${input.reason ?? null},
      ${input.before === undefined ? null : tx.json(redact(input.before) as never)},
      ${input.after === undefined ? null : tx.json(redact(input.after) as never)},
      ${input.correlationId ?? null}, ${input.supportSessionId ?? null}
    )
  `;
}

/**
 * Appends an outbox event inside the same transaction as the business change.
 * Payloads carry identifiers and amounts only — never personal information.
 */
export async function emitEvent(
  tx: Sql,
  input: {
    organisationId: string;
    eventType: string;
    resourceType: string;
    resourceId?: string | null;
    payload?: Record<string, unknown>;
    correlationId?: string | null;
  },
): Promise<void> {
  await tx`
    insert into outbox_events (
      organisation_id, event_type, resource_type, resource_id, payload, correlation_id
    ) values (
      ${input.organisationId}, ${input.eventType}, ${input.resourceType},
      ${input.resourceId ?? null},
      ${tx.json(redact(input.payload ?? {}) as never)},
      ${input.correlationId ?? null}
    )
  `;
}
