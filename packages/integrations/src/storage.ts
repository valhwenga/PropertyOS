/**
 * Private document storage adapter.
 *
 * Objects live in a PRIVATE bucket. There is no public URL anywhere in the
 * product: a download is served by minting a short lived signed URL, and only
 * after the caller's permission has been checked server side.
 */

export interface UploadConstraints {
  maxBytes: number;
  allowedContentTypes: readonly string[];
}

export const DOCUMENT_CONSTRAINTS: UploadConstraints = {
  maxBytes: 25 * 1024 * 1024,
  allowedContentTypes: [
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'text/csv', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
};

/** Executable content is rejected outright, whatever the declared type says. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'js', 'jar', 'sh',
  'ps1', 'vbs', 'app', 'deb', 'rpm', 'apk',
]);

/** Magic-byte sniffing: the DECLARED content type is never trusted on its own. */
const SIGNATURES: Array<{ type: string; bytes: number[]; offset?: number }> = [
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
];

export function detectContentType(head: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (sig.bytes.every((b, i) => head[offset + i] === b)) return sig.type;
  }
  return null;
}

export interface UploadValidation {
  ok: boolean;
  reason?: string;
}

export function validateUpload(params: {
  filename: string;
  declaredContentType: string;
  byteSize: number;
  head?: Uint8Array;
}): UploadValidation {
  const extension = params.filename.split('.').pop()?.toLowerCase() ?? '';
  if (BLOCKED_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `Files of type ".${extension}" are not accepted.` };
  }
  if (params.byteSize <= 0) return { ok: false, reason: 'The file is empty.' };
  if (params.byteSize > DOCUMENT_CONSTRAINTS.maxBytes) {
    return {
      ok: false,
      reason: `The file is larger than the ${DOCUMENT_CONSTRAINTS.maxBytes / (1024 * 1024)} MB limit.`,
    };
  }
  if (!DOCUMENT_CONSTRAINTS.allowedContentTypes.includes(params.declaredContentType)) {
    return { ok: false, reason: `Files of type "${params.declaredContentType}" are not accepted.` };
  }
  if (params.head && params.head.length >= 8) {
    const actual = detectContentType(params.head);
    // A recognisable signature that contradicts the declared type is a rejection.
    if (actual && actual !== params.declaredContentType) {
      return {
        ok: false,
        reason: `The file content is ${actual} but it was declared as ${params.declaredContentType}.`,
      };
    }
  }
  return { ok: true };
}

export type ScanOutcome =
  | { status: 'clean' }
  | { status: 'infected'; detail: string }
  | { status: 'skipped_not_configured'; detail: string }
  | { status: 'failed'; detail: string };

/**
 * Malware scanning.
 *
 * When no scanner is configured this returns `skipped_not_configured` and the
 * document STAYS QUARANTINED. The product never claims a file was scanned when
 * it was not, and a quarantined file can never be shared with a resident — the
 * database check constraint `documents_quarantine_not_shared` enforces that even
 * if application code were wrong.
 */
export async function scanDocument(
  _object: { bucket: string; key: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScanOutcome> {
  if (!env.MALWARE_SCANNER) {
    return {
      status: 'skipped_not_configured',
      detail:
        'No malware scanner is configured (MALWARE_SCANNER is unset), so this file has NOT been scanned. ' +
        'It remains quarantined and cannot be shared. See docs/runbooks/uploads.md.',
    };
  }
  return {
    status: 'failed',
    detail:
      `MALWARE_SCANNER is set to "${env.MALWARE_SCANNER}" but no scanner client is implemented in this release. ` +
      'The file remains quarantined. See docs/known-limitations.md.',
  };
}
