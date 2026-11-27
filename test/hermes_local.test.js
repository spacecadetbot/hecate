import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setEnvVars, readEnvVar, enableLocalHermesApi } from '../src/hermes_local.js';

test('setEnvVars replaces, uncomments and appends', () => {
  const out = setEnvVars('A=1\n# API_SERVER_ENABLED=false\nAPI_SERVER_PORT=1\n', { API_SERVER_ENABLED: 'true', API_SERVER_PORT: '8642', API_SERVER_KEY: 'k' });
  assert.match(out, /^A=1$/m); assert.match(out, /^API_SERVER_ENABLED=true$/m); assert.match(out, /^API_SERVER_PORT=8642$/m); assert.match(out, /^API_SERVER_KEY=k$/m);
  assert.equal(readEnvVar(out, 'API_SERVER_KEY'), 'k');
});

test('enableLocalHermesApi writes env, backs up, keeps an existing key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-'));
  fs.mkdirSync(path.join(home, '.hermes'));
  fs.writeFileSync(path.join(home, '.hermes', '.env'), 'API_SERVER_KEY=keepme\nFOO=bar\n');
  const r = enableLocalHermesApi({ home, restart: false });
  assert.ok(r.ok); assert.equal(r.api_key, 'keepme');
  const text = fs.readFileSync(path.join(home, '.hermes', '.env'), 'utf8');
  assert.match(text, /API_SERVER_HOST=0\.0\.0\.0/); assert.match(text, /FOO=bar/);
  assert.ok(fs.existsSync(path.join(home, '.hermes', '.env.hecate-bak')));
  assert.equal(enableLocalHermesApi({ home: path.join(home, 'nope'), restart: false }).ok, false);
});
