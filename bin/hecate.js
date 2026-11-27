#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// `hecate` — control panel for the gateway. Run it from anywhere once linked (see README → The hecate command).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The gateway reads .env and ./data relative to its own folder, wherever you run `hecate` from.
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const { main } = await import('../src/tui.js');
await main(process.argv.slice(2));
