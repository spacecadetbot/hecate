#!/usr/bin/env node
// Interactive first-run setup: `npm run setup`. Zero dependencies, works over SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s), dim = (s) => c('2', s), green = (s) => c('32', s), yellow = (s) => c('33', s), red = (s) => c('31', s), cyan = (s) => c('36', s);

/** Line-queue reader: robust for typed input AND piped input (used by the tests). */
function makeIO(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, terminal: false });
  const queue = []; const waiters = []; let closed = false;
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  rl.on('close', () => { closed = true; while (waiters.length) waiters.shift()(null); });
  const nextLine = () => new Promise((res) => (queue.length ? res(queue.shift()) : closed ? res(null) : waiters.push(res)));
  return {
    say: (s = '') => output.write(`${s}\n`),
    async ask(q, def) {
      output.write(`${q}${def !== undefined && def !== '' ? dim(` [${def}]`) : ''} ${cyan('›')} `);
      const l = await nextLine();
      if (l === null) { output.write('\n'); throw new Error('input closed'); }
      return l.trim() === '' ? (def ?? '') : l.trim();
    },
    async yes(q, def = true) {
      for (;;) {
        const a = (await this.ask(`${q} ${dim(def ? '(Y/n)' : '(y/N)')}`, '')).toLowerCase();
        if (a === '') return def; if (/^y/.test(a)) return true; if (/^n/.test(a)) return false;
      }
    },
    async choose(q, options, def = 0) {
      options.forEach((o, i) => output.write(`  ${bold(String(i + 1))}) ${o.label}${o.hint ? dim(`  ${o.hint}`) : ''}\n`));
      for (;;) {
        const a = await this.ask(q, String(def + 1));
        const n = Number(a); if (n >= 1 && n <= options.length) return options[n - 1].value;
      }
    },
    close: () => rl.close(),
  };
}

function step(io, n, total, title, blurb) {
  io.say(); io.say(bold(`Step ${n} of ${total} — ${title}`)); if (blurb) io.say(dim(blurb));
}
const has = (cmd) => spawnSync('which', [cmd], { encoding: 'utf8' }).status === 0;

export function renderEnv(v) {
  return [
    '# Written by `npm run setup`. Edit freely; see .env.example for every option.',
    `HECATE_APPLE_BUNDLE_ID=${v.bundleId}`,
    `HECATE_DEV_LOGIN=${v.devLogin ? 1 : 0}`,
    `HECATE_OPEN_SIGNUP=0`,
    `HECATE_HOST=${v.host}`,
    `HECATE_PORT=${v.port}`,
    `HECATE_DATA_DIR=${v.dataDir}`,
    '',
  ].join('\n');
}

export async function runSetup({ io = makeIO(), cwd = process.cwd(), probe = true } = {}) {
  const TOTAL = 6;
  io.say(bold('\n  Hecate Gateway — setup'));
  io.say(dim('  Answer a few questions; press Enter to accept the [default]. Nothing leaves your network.'));

  // 1 ── environment
  step(io, 1, TOTAL, 'Checking this machine');
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  io.say(`  ${nodeOk ? green('✓') : red('✗')} Node.js ${process.versions.node} ${nodeOk ? '' : red('(need 22.13 or newer)')}`);
  if (!nodeOk) { io.say(red('  Install Node 22+ (see README → Linux) and run setup again.')); return { ok: false }; }
  for (const [bin, pkg, why] of [['ffmpeg', 'ffmpeg', 'thumbnails, video frames, audio conversion'], ['pdftotext', 'poppler-utils', 'reading PDFs'], ['unzip', 'unzip', 'reading docx/pptx/xlsx']]) {
    io.say(`  ${has(bin) ? green('✓') : yellow('!')} ${bin}${has(bin) ? '' : dim(`  missing — ${why}: sudo apt install ${pkg}`)}`);
  }

  // 2 ── sign-in
  step(io, 2, TOTAL, 'How will people sign in?', 'Your app uses Sign in with Apple. For testing before the app is ready you can use a no-password developer login.');
  const mode = await io.choose('Choose', [
    { value: 'apple', label: 'Sign in with Apple', hint: 'needs your app’s bundle ID' },
    { value: 'both', label: 'Apple + developer login', hint: 'recommended while building the app' },
    { value: 'dev', label: 'Developer login only', hint: 'testing with curl; INSECURE if exposed' },
  ], 1);
  let bundleId = '';
  if (mode !== 'dev') bundleId = await io.ask('App bundle ID (e.g. com.yourname.Hecate; comma-separate several)', '');
  if (mode !== 'dev' && !bundleId) io.say(yellow('  No bundle ID yet — Apple sign-in will stay off until you add HECATE_APPLE_BUNDLE_ID to .env.'));
  const devLogin = mode !== 'apple' || !bundleId;
  if (devLogin) io.say(yellow('  Developer login ON. Turn it off (HECATE_DEV_LOGIN=0) before you expose the server beyond your home network.'));

  // 3 ── network & storage
  step(io, 3, TOTAL, 'Network and storage');
  const host = await io.ask('Listen address (0.0.0.0 = reachable from your other devices)', '0.0.0.0');
  const port = Number(await io.ask('Port', '8080')) || 8080;
  const dataDir = path.resolve(cwd, await io.ask('Where to keep the database and uploads', './data'));
  const v = { bundleId, devLogin, host, port, dataDir };

  const envFile = path.join(cwd, '.env');
  if (fs.existsSync(envFile) && !(await io.yes(`  ${yellow('.env already exists.')} Replace it? (a copy is saved as .env.bak)`, true))) {
    io.say('  Keeping your existing .env. Setup stopped.'); return { ok: false };
  }
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, `${envFile}.bak`);
  fs.writeFileSync(envFile, renderEnv(v), { mode: 0o600 });
  io.say(`  ${green('✓')} wrote ${envFile}`);

  // Open the data directory with these answers (secrets are encrypted with a key kept in the data dir).
  Object.assign(process.env, {
    HECATE_APPLE_BUNDLE_ID: bundleId, HECATE_DEV_LOGIN: devLogin ? '1' : '0', HECATE_HOST: host, HECATE_PORT: String(port), HECATE_DATA_DIR: dataDir,
  });
  const { createGateway } = await import('./server.js');
  const gw = createGateway({ noDotEnv: true, appleBundleId: bundleId, devLogin, host, port, dataDir });
  const { registry, settings } = gw.app;

  // 4 ── LM Studio
  step(io, 4, TOTAL, 'Connect LM Studio', 'Add each machine running LM Studio. In LM Studio: Developer tab → turn on the server and “Serve on Local Network”.');
  io.say(dim('  Tiers: “fast” answers everyday chat quickly; “smart” is used for “think harder” and as a fallback.'));
  const added = [];
  for (let first = true; ; first = false) {
    if (!first && !(await io.yes('Add another LM Studio server?', false))) break;
    if (first && !(await io.yes('Add an LM Studio server now?', true))) break;
    const name = await io.ask('Name (e.g. Gaming PC)', first ? 'Gaming PC' : 'MacBook');
    let url = await io.ask('Address (host:port or full URL)', 'http://localhost:1234');
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    const tier = await io.choose('Tier for this machine', [
      { value: 'fast', label: 'fast', hint: 'quick, always-on model' }, { value: 'smart', label: 'smart', hint: 'bigger model; may sleep' },
    ], added.length === 0 ? 0 : 1);
    const needsKey = await io.yes('Does it require an API token? (LM Studio → Server Settings → Require Authentication)', false);
    const api_key = needsKey ? await io.ask('API token') : '';
    if (!probe) { io.say(dim('  (skipping connection test)')); continue; }
    io.say(dim('  Connecting…'));
    const { server, validation } = await registry.addServer({ name, base_url: url, api_key, default_tier: tier });
    if (validation.ok) {
      io.say(`  ${green('✓')} ${validation.models.length} model(s) found:`);
      for (const m of validation.models) io.say(`     • ${m.upstream_id}  ${dim(`[${m.capabilities.join(', ')}]${m.loaded ? ' loaded' : ''}`)}`);
      added.push(server);
    } else {
      io.say(`  ${red('✗')} could not reach it: ${validation.error}`);
      io.say(dim('    Check the address, that the LM Studio server is running, and “Serve on Local Network” is on. It is saved anyway; fix it later in the admin API.'));
      added.push(server);
    }
  }
  if (!added.length) io.say(yellow('  No model server yet. Add one later with POST /v1/admin/model-servers (see README).'));

  // 5 ── optional extras
  step(io, 5, TOTAL, 'Optional extras');
  if (await io.yes('Do you have a speech-to-text server (OpenAI-style /v1/audio/transcriptions)?', false)) {
    settings.set('stt_url', await io.ask('Its address', 'http://localhost:8000'));
    const m = await io.ask('Model name to request (blank = server default)', ''); if (m) settings.set('stt_model', m);
  } else io.say(dim('  Without one, voice notes go straight to audio-capable models (e.g. Gemma) or are skipped.'));
  if (await io.yes('Attach a Hermes Agent now?', false)) {
    gw.app.hermes.attach({ url: await io.ask('Hermes API address', 'http://localhost:8642'), api_key: (await io.ask('Hermes API key (API_SERVER_KEY, blank if none)', '')) || undefined });
    io.say(dim('  Hermes needs its API server on (API_SERVER_ENABLED=true). Change this later with: hecate hermes'));
  }

  // 6 ── summary
  step(io, 6, TOTAL, 'Done');
  gw.db.close?.();
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  io.say(green('  Setup complete.'));
  io.say('');
  io.say(`  ${bold('Manage it:')}       hecate   ${dim('(menu: models, people, Hermes, logs)')}`);
  io.say(`  ${bold('Reach it at:')}     ${(ips.length ? ips : ['localhost']).map((ip) => `http://${ip}:${port}`).join('  ')}`);
  io.say(`  ${bold('Check health:')}    curl http://localhost:${port}/v1/capabilities`);
  if (devLogin) io.say(`  ${bold('Test sign-in:')}    curl -X POST http://localhost:${port}/v1/auth/dev -H 'content-type: application/json' -d '{"name":"owen"}'`);
  io.say(`  ${bold('Run at boot:')}     hecate autostart on`);
  io.say(dim('  The first real person to sign in becomes the owner. Invite others from the `hecate` menu → People'));
  return { ok: true, port, dataDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io = makeIO();
  runSetup({ io }).then((r) => { io.close(); process.exit(r.ok ? 0 : 1); })
    .catch((e) => { console.error(red(`\nSetup stopped: ${e.message}`)); process.exit(1); });
}
export { makeIO };
