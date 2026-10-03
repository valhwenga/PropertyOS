# Runbook — document uploads and private files

## Current state

**No malware scanner is configured.** Uploads are recorded with
`scan_status = 'skipped_not_configured'` and remain `quarantined = true`.

A quarantined document **cannot** be shared with a resident, a contractor or an
owner. This is enforced by the database check constraint
`documents_quarantine_not_shared`, not only by application code. The product
never claims a file was scanned when it was not.

## Validation applied today

* Blocked extensions: executables, scripts, installers and archives of them.
* Size limit: 25 MB.
* Allowed content types: PDF, JPEG, PNG, WebP, HEIC, CSV, DOCX, XLSX.
* **Magic-byte sniffing.** The declared content type is never trusted on its
  own; a file whose signature contradicts its declared type is rejected.

## Access

Objects live in a private bucket. There are no public URLs. A download mints a
short-lived signed URL only after a server-side permission check, and the grant
is recorded in `document_access_grants`. Financial exports are private documents
in their own right and run under the caller's own scope.

## To enable scanning

1. Deploy a scanner (ClamAV or an equivalent service).
2. Set `MALWARE_SCANNER`, `CLAMAV_HOST`, `CLAMAV_PORT`.
3. Implement the scanner client in `packages/integrations/src/storage.ts`
   (`scanDocument` currently returns `failed` with an explicit message rather
   than pretending to scan).
4. Verify with a harmless EICAR test file that an infected result quarantines the
   document and that it cannot then be shared.
