import { createConnection } from 'node:net';

/**
 * ClamAV client, speaking the INSTREAM protocol directly.
 *
 * INSTREAM streams the file to clamd over TCP in length-prefixed chunks,
 * terminated by a zero-length chunk. The daemon replies with one line:
 *   "stream: OK"                        -> clean
 *   "stream: <SignatureName> FOUND"     -> infected
 *   "... ERROR"                         -> the scan failed
 *
 * A failed scan is NEVER treated as clean. The document stays quarantined, which
 * is the whole point: the product must not claim a file was checked when the
 * check did not complete.
 */

export interface ClamAvConfig {
  host: string;
  port: number;
  timeoutMs?: number;
  /** Must not exceed clamd's StreamMaxLength, or the daemon aborts the scan. */
  maxBytes?: number;
}

export type ClamAvResult =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'failed'; detail: string };

const CHUNK_SIZE = 64 * 1024;

export async function scanWithClamAv(
  config: ClamAvConfig,
  body: Uint8Array,
): Promise<ClamAvResult> {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxBytes = config.maxBytes ?? 32 * 1024 * 1024;

  if (body.byteLength > maxBytes) {
    return {
      status: 'failed',
      detail: `File is ${body.byteLength} bytes, above the scanner limit of ${maxBytes}. It was NOT scanned.`,
    };
  }

  return new Promise<ClamAvResult>((resolve) => {
    const socket = createConnection({ host: config.host, port: config.port });
    let response = '';
    let settled = false;

    const finish = (result: ClamAvResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(
      () => finish({
        status: 'failed',
        detail: `The virus scanner did not respond within ${timeoutMs}ms. The file was NOT scanned.`,
      }),
      timeoutMs,
    );

    socket.on('error', (error) =>
      finish({
        status: 'failed',
        detail: `Could not reach the virus scanner: ${error.message}. The file was NOT scanned.`,
      }),
    );

    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });

    socket.on('end', () => finish(interpret(response)));
    socket.on('close', () => finish(interpret(response)));

    socket.on('connect', () => {
      // zINSTREAM: the null-terminated form, so the command cannot be split.
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < body.byteLength; offset += CHUNK_SIZE) {
        const slice = body.subarray(offset, Math.min(offset + CHUNK_SIZE, body.byteLength));
        const header = Buffer.alloc(4);
        header.writeUInt32BE(slice.byteLength);
        socket.write(header);
        socket.write(slice);
      }
      // Zero-length chunk ends the stream.
      const terminator = Buffer.alloc(4);
      terminator.writeUInt32BE(0);
      socket.write(terminator);
    });
  });
}

export function interpret(response: string): ClamAvResult {
  const line = response.replace(/\0/g, '').trim();
  if (!line) {
    return { status: 'failed', detail: 'The virus scanner returned no result. The file was NOT scanned.' };
  }
  if (/\bERROR\b/i.test(line)) {
    return { status: 'failed', detail: `The virus scanner reported an error: ${line}` };
  }
  if (/\bFOUND\b/.test(line)) {
    const signature = /:\s*(.+?)\s+FOUND/.exec(line)?.[1] ?? 'unknown signature';
    return { status: 'infected', signature };
  }
  if (/\bOK\b/.test(line)) return { status: 'clean' };
  return { status: 'failed', detail: `Unrecognised scanner response: ${line}` };
}

/** The standard harmless test file every scanner recognises. Used in tests. */
export const EICAR_TEST_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
