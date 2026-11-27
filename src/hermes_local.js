// Turns on the API server of a Hermes Agent installed on THIS machine, so people don't have to edit ~/.hermes/.env by hand.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const hermesEnvPath = (home = os.homedir()) => path.join(home, '.hermes', '.env');
export const hermesInstalledLocally = (home) => fs.existsSync(hermesEnvPath(home));

/** Set KEY=value lines in env text, replacing existing (also commented-out) ones. Returns the new text. */
export function setEnvVars(text, vars) {
  let out = text.endsWith('\n') || text === '' ? text : `${text}\n`;
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^\\s*#?\\s*${k}\\s*=.*$`, 'm');
    out = re.test(out) ? out.replace(re, `${k}=${v}`) : `${out}${k}=${v}\n`;
  }
  return out;
}
export const readEnvVar = (text, k) => (text.match(new RegExp(`^\\s*${k}\\s*=\\s*(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '');

/** Enables the API server (keeps an existing key), backs up .env, restarts Hermes. Returns {ok, url, api_key, restarted, message}. */
export function enableLocalHermesApi({ home = os.homedir(), restart = true, port = 8642 } = {}) {
  const file = hermesEnvPath(home);
  if (!fs.existsSync(file)) return { ok: false, message: 'Hermes does not seem to be installed on this machine (no ~/.hermes/.env).' };
  const text = fs.readFileSync(file, 'utf8');
  const key = readEnvVar(text, 'API_SERVER_KEY') || crypto.randomBytes(24).toString('hex');
  fs.copyFileSync(file, `${file}.hecate-bak`);
  fs.writeFileSync(file, setEnvVars(text, { API_SERVER_ENABLED: 'true', API_SERVER_HOST: '0.0.0.0', API_SERVER_PORT: String(port), API_SERVER_KEY: key }), { mode: 0o600 });
  let restarted = false;
  if (restart) {
    const r = spawnSync('hermes', ['-p', 'default', 'gateway', 'restart'], { encoding: 'utf8', timeout: 60000 });
    restarted = r.status === 0;
  }
  return {
    ok: true, url: `http://localhost:${port}`, api_key: key, restarted,
    message: restarted ? 'Hermes API turned on and Hermes restarted.' : 'Hermes API turned on. Restart Hermes to apply it:  hermes -p default gateway restart',
  };
}
