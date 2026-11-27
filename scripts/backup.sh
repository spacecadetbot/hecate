#!/usr/bin/env bash
# Nightly backup: a consistent copy of the database plus the uploaded files, keeping the last 14 days.
# Cron example (3:15 every night):  15 3 * * *  /opt/hecate-gateway/scripts/backup.sh /mnt/backup/hecate
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${1:?usage: backup.sh <destination-folder>}"
DATA="${HECATE_DATA_DIR:-./data}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
node --disable-warning=ExperimentalWarning src/cli.js backup "$DEST/hecate-$STAMP.db" >/dev/null
tar -C "$DATA" -czf "$DEST/files-$STAMP.tar.gz" files
find "$DEST" -name 'hecate-*.db' -mtime +14 -delete
find "$DEST" -name 'files-*.tar.gz' -mtime +14 -delete
echo "Backed up to $DEST ($STAMP)"
