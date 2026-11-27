#!/usr/bin/env bash
# One-line install:  curl -fsSL <raw-url>/scripts/get.sh | bash   (or: git clone <url> && cd hecate-gateway && ./scripts/install.sh)
# Override with HECATE_REPO=<git url> HECATE_DIR=<folder>.
set -e
REPO="${HECATE_REPO:-https://github.com/spacecadetbot/hecate.git}"
DIR="${HECATE_DIR:-$HOME/.hecate/gateway}"
command -v git >/dev/null 2>&1 || { echo "git is required."; exit 1; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else mkdir -p "$(dirname "$DIR")"; git clone "$REPO" "$DIR"; fi
exec bash "$DIR/scripts/install.sh"
