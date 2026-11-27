import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { startFakeLLM } from './helpers.js';
import { runSetup, makeIO } from '../src/setup.js';
import { openDb } from '../src/db.js';

test('setup wizard writes .env and registers an LM Studio server (piped answers)', async () => {
  const llm = await startFakeLLM();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hecate-setup-'));
  const input = new PassThrough(); const out = new PassThrough(); let text = '';
  out.on('data', (d) => { text += d; });
  const answers = [
    '2', 'com.example.Hecate',          // sign-in: apple + dev, bundle id
    '127.0.0.1', '18080', './d',        // network
    'y', 'Gaming PC', llm.url, '1', 'n', // LM Studio: add, name, url, tier fast, no token
    'n',                                 // add another
    'n', 'n',                            // stt, hermes
  ];
  input.end(answers.join('\n') + '\n');
  const r = await runSetup({ io: makeIO(input, out), cwd });
  assert.equal(r.ok, true, text);
  const env = fs.readFileSync(path.join(cwd, '.env'), 'utf8');
  assert.match(env, /HECATE_APPLE_BUNDLE_ID=com\.example\.Hecate/);
  assert.match(env, /HECATE_DEV_LOGIN=1/);
  assert.match(env, /HECATE_PORT=18080/);
  assert.match(text, /2 model\(s\) found/);
  const db = openDb(path.join(cwd, 'd', 'hecate.db'));
  assert.equal(db.all('SELECT * FROM model_servers').length, 1);
  assert.equal(db.get("SELECT kind FROM model_servers").kind, 'lmstudio');
  db.close();
  await llm.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});
