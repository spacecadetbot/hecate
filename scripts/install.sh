#!/usr/bin/env bash
# Hecate Gateway installer: run from inside the hecate-gateway folder.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Node 22 or newer is required. Install it from https://nodejs.org (or: brew install node) and run this again."
  exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 22 ]; then
  echo "Node $MAJOR found, but Node 22 or newer is required."
  exit 1
fi

# Put the `hecate` command on the PATH.
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
chmod +x "$ROOT/bin/hecate.js"
ln -sf "$ROOT/bin/hecate.js" "$BIN_DIR/hecate"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    RC="$HOME/.zshrc"; [ -n "$BASH_VERSION" ] && [ ! -f "$RC" ] && RC="$HOME/.bashrc"
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$RC"
    echo "Added $BIN_DIR to your PATH in $RC. Open a new terminal window to pick it up."
    export PATH="$BIN_DIR:$PATH"
    ;;
esac

# First-time setup, then start in the background.
if [ ! -f "$ROOT/.env" ]; then
  hecate gateway   # first run: setup, then starts in the background
else
  hecate restart || hecate start
fi
echo
echo "Done. Useful commands:  hecate (menu)   hecate stop   hecate start   hecate status   hecate logs"
echo "To start at login:       hecate autostart on"
