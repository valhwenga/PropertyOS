#!/usr/bin/env bash
# Spike PropertyOS — database backup.
#
# Captures the database only. Storage OBJECT BYTES ARE NOT INCLUDED:
# Supabase database backups do not cover Storage, so object backup must be
# arranged separately and the two restored together. See docs/runbooks/recovery.md.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="${BACKUP_DIR}/propertyos-${STAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "Backing up to ${TARGET}"
# Custom format so pg_restore can be selective, and compressed.
#
# --no-owner, because the role that restores is rarely the role that owned the
# objects. NOT --no-privileges: the grants to propertyos_app are what make the
# restored database usable by the application at all. A rehearsal with the
# privileges stripped restored cleanly and then answered "permission denied for
# table leases" to the application role, which is a recovery that has not
# recovered anything. The target cluster must therefore carry the roles before
# the restore; scripts/restore-verify.sh creates them, and docs/deployment.md
# has them for a real one.
pg_dump --format=custom --compress=9 --no-owner \
        --file="$TARGET" "$DATABASE_URL"

# A checksum, so a corrupted archive is detected before it is relied on.
sha256sum "$TARGET" > "${TARGET}.sha256"

SIZE=$(du -h "$TARGET" | cut -f1)
echo "Backup complete: ${TARGET} (${SIZE})"
echo
echo "REMINDER: this archive does NOT contain Storage objects (lease documents,"
echo "inspection photos, proof of payment). Back those up separately and restore"
echo "both together, or the restored database will reference files that do not exist."
