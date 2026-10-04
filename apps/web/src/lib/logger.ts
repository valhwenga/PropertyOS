import 'server-only';

/**
 * Structured logging.
 *
 * Every line is JSON with a correlation id so a user-facing error reference can
 * be traced to the exact request. Nothing sensitive is logged: the redaction
 * list below is applied to every field, and message bodies are never logged at
 * all.
 */

const SENSITIVE = /(password|secret|token|authorization|cookie|identity[_-]?number|account[_-]?number|storage[_-]?key)/i;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    service: 'propertyos-web',
    revision: process.env.APP_REVISION ?? 'unknown',
    ...(scrub(fields) as Record<string, unknown>),
  });
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
