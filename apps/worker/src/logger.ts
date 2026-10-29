/**
 * The worker's log line.
 *
 * Lived in `main.ts` as a private function, which was fine until something
 * other than the loop had a reason to say anything: `watchForTrouble` takes it
 * as a parameter, and the handlers could not reach it at all. Here instead, so
 * every part of the worker writes the same shape of line with the same worker
 * id on it.
 *
 * Structured, and deliberately free of personal data: a log that carries a
 * resident's email is a log that cannot be shipped anywhere.
 */
export const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;

export type Log = (
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: Record<string, unknown>,
) => void;

export const log: Log = (level, message, extra = {}) => {
  process.stdout.write(`${JSON.stringify({
    level, worker: WORKER_ID, message, timestamp: new Date().toISOString(), ...extra,
  })}\n`);
};
