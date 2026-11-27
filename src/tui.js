// The `hecate` control panel: a keyboard-driven menu for everything you'd otherwise do with curl.
// Zero dependencies: arrow keys + Enter, Esc to go back. Works over SSH.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createGateway } from './server.js';
import { loadConfig } from './config.js';
import * as daemon from './daemon.js';
import { createInvite } from './admin.js';
import { hermesInstalledLocally, enableLocalHermesApi } from './hermes_local.js';
import { CAPABILITIES, TIERS } from './servers.js';

const stdin = process.stdin, stdout = process.stdout;
const useColor = stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => sgr('1', s), dim = (s) => sgr('2', s), green = (s) => sgr('32', s), yellow = (s) => sgr('33', s);
const red = (s) => sgr('31', s), cyan = (s) => sgr('36', s), magenta = (s) => sgr('35', s);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const clipTo = (s, w) => { const plain = stripAnsi(s); return plain.length <= w ? s : `${plain.slice(0, Math.max(0, w - 1))}…`; };

// ------------------------------------------------------------------ terminal plumbing

let started = false;
function enterScreen() {
  if (started || !stdout.isTTY) return;
  started = true;
  stdout.write('\x1b[?1049h\x1b[?25l');
  readline.emitKeypressEvents(stdin);
}
function leaveScreen() {
  if (!started) return;
  started = false;
  stdout.write('\x1b[?25h\x1b[?1049l');
}
process.on('exit', leaveScreen);

class Quit extends Error {}

function header(extra = []) {
  const w = stdout.columns || 80;
  const lines = ['', `  ${magenta('✦')} ${bold('HECATE')}  ${dim('gateway control panel')}`];
  for (const e of extra) lines.push(`  ${clipTo(e, w - 4)}`);
  lines.push('');
  return lines;
}

/**
 * Arrow-key menu. items: { label, hint?, value, header? (non-selectable heading), disabled? }.
 * Resolves to the chosen value, or null when the user presses Esc / q / left arrow.
 */
function select({ title, lines = [], items, footer = '↑↓ move   enter choose   esc back', initial = 0 }) {
  enterScreen();
  return new Promise((resolve, reject) => {
    const selectable = (i) => items[i] && !items[i].header && !items[i].disabled;
    let idx = Math.min(Math.max(initial, 0), items.length - 1);
    if (!selectable(idx)) idx = items.findIndex((_, i) => selectable(i));
    let top = 0;

    const move = (dir) => {
      let n = idx;
      for (let k = 0; k < items.length; k++) {
        n = (n + dir + items.length) % items.length;
        if (selectable(n)) { idx = n; break; }
      }
    };
    const render = () => {
      const w = stdout.columns || 80, rows = stdout.rows || 24;
      const head = [...header(lines), ...(title ? [`  ${bold(title)}`, ''] : [])];
      const room = Math.max(3, rows - head.length - 3);
      if (idx < top) top = idx;
      if (idx >= top + room) top = idx - room + 1;
      const out = [...head];
      items.slice(top, top + room).forEach((it, k) => {
        const i = top + k;
        if (it.header) { out.push(`  ${dim(it.label)}`); return; }
        const hint = it.hint ? `  ${dim(it.hint)}` : '';
        const line = clipTo(`${it.label}${hint}`, w - 6);
        out.push(i === idx ? `  ${cyan('›')} ${bold(line)}` : `    ${it.disabled ? dim(line) : line}`);
      });
      if (items.length > room) out.push(dim(`  … ${items.length - room} more (scroll)`));
      out.push('', `  ${dim(footer)}`);
      stdout.write(`\x1b[2J\x1b[H${out.join('\n')}`);
    };
    const cleanup = () => {
      stdin.removeListener('keypress', onKey);
      stdout.removeListener('resize', render);
      stdin.setRawMode?.(false);
    };
    const finish = (value) => { cleanup(); resolve(value); };
    const onKey = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') { cleanup(); reject(new Quit()); return; }
      if (key.name === 'up' || str === 'k') { move(-1); render(); }
      else if (key.name === 'down' || str === 'j') { move(1); render(); }
      else if (key.name === 'home') { idx = items.findIndex((_, i) => selectable(i)); render(); }
      else if (key.name === 'end') { for (let i = items.length - 1; i >= 0; i--) if (selectable(i)) { idx = i; break; } render(); }
      else if (key.name === 'return' || key.name === 'right' || str === ' ') { if (selectable(idx)) finish(items[idx].value); }
      else if (key.name === 'escape' || key.name === 'left' || str === 'q') finish(null);
      else if (/^[1-9]$/.test(str ?? '')) {
        const sel = items.map((it, i) => (selectable(i) ? i : -1)).filter((i) => i >= 0);
        const n = Number(str) - 1;
        if (sel[n] !== undefined) { idx = sel[n]; render(); }
      }
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.on('resize', render);
    render();
  });
}

/** Plain text question. Returns the trimmed answer, or the default when you just press Enter. */
async function ask(question, def = '') {
  enterScreen();
  stdout.write('\x1b[?25h');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`\n  ${question}${def !== '' ? dim(` [${def}]`) : ''} ${cyan('›')} `, resolve);
    rl.once('close', () => resolve(def));
  });
  rl.close();
  stdout.write('\x1b[?25l');
  return String(answer).trim() || def;
}

async function confirm(question, def = false) {
  const a = (await ask(`${question} ${dim(def ? '(Y/n)' : '(y/N)')}`, '')).toLowerCase();
  return a === '' ? def : a.startsWith('y');
}

/** Show a message screen and wait for a key. */
function say(lines, { title } = {}) {
  enterScreen();
  return new Promise((resolve, reject) => {
    const out = [...header(), ...(title ? [`  ${bold(title)}`, ''] : []), ...lines.map((l) => `  ${l}`), '', `  ${dim('press any key')}`];
    stdout.write(`\x1b[2J\x1b[H${out.join('\n')}`);
    const onKey = (str, key = {}) => {
      stdin.removeListener('keypress', onKey);
      stdin.setRawMode?.(false);
      if (key.ctrl && key.name === 'c') reject(new Quit()); else resolve();
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('keypress', onKey);
  });
}

// ------------------------------------------------------------------ helpers

const caps = (m) => (m.capabilities ?? []).filter((c) => c !== 'text').join(' ') || 'text only';
const ctx = (m) => (m.context_length ? `${Math.round(m.context_length / 1024)}k ctx` : '');
const modelHint = (m) => [m.server_name, caps(m), ctx(m), m.loaded ? 'loaded' : ''].filter(Boolean).join(' · ');

const probe = (port) => daemon.probe(port);

/** Set KEY=value in .env (adds it if missing). The gateway must be restarted to notice. */
function setEnv(key, value) {
  const file = path.resolve('.env');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
  fs.writeFileSync(file, next, { mode: 0o600 });
}

function chatModels(gw) {
  return gw.app.registry.listAdminModels().filter((m) => m.present && !m.capabilities.includes('embedding'));
}
function pickedName(gw, key) {
  const id = gw.app.settings.get(key);
  const m = id ? chatModels(gw).find((x) => x.id === id) : null;
  return m ? m.display_name : null;
}
// ------------------------------------------------------------------ screens

async function pickModels(gw) {
  const { settings, registry } = gw.app;
  for (const tier of TIERS) {
    const models = chatModels(gw).filter((m) => m.enabled);
    if (!models.length) {
      await say([yellow('No models found yet.'), 'Add your LM Studio server first: Model servers → Add a server.'], { title: 'Pick your models' });
      return;
    }
    const key = `model_${tier}`;
    const current = settings.get(key);
    const items = models.map((m) => ({
      label: `${m.id === current ? green('●') : ' '} ${m.display_name}`,
      hint: modelHint(m),
      value: m.id,
    }));
    items.push({ header: true, label: '' });
    items.push({ label: dim('Let the gateway choose for me'), value: '__auto' });
    const blurb = tier === 'fast'
      ? 'FAST answers everyday chat. Pick a model that responds quickly.'
      : 'SMART is used for "Think harder" and harder questions. Pick your most capable model.';
    const chosen = await select({
      title: `Pick your ${tier.toUpperCase()} model`,
      lines: [dim(blurb), dim("Tip: you can use the same model for both. Models you don't pick won't be loaded for normal chat.")],
      items,
      initial: Math.max(0, models.findIndex((m) => m.id === current)),
    });
    if (chosen === null) return;
    if (chosen === '__auto') { settings.set(key, ''); continue; }
    settings.set(key, chosen);
    registry.updateModel(chosen, { tier, enabled: true });
  }
  await say([
    `${bold('Fast')}   ${pickedName(gw, 'model_fast') ?? dim('gateway chooses')}`,
    `${bold('Smart')}  ${pickedName(gw, 'model_smart') ?? dim('gateway chooses')}`,
    '', dim('Takes effect immediately; no restart needed.'),
  ], { title: 'Saved' });
}

async function modelDetail(gw, id) {
  const { registry } = gw.app;
  for (;;) {
    const m = registry.listAdminModels().find((x) => x.id === id);
    if (!m) return;
    const pick = gw.app.settings.get('model_fast') === id ? 'FAST pick' : gw.app.settings.get('model_smart') === id ? 'SMART pick' : '';
    const action = await select({
      title: m.display_name,
      lines: [dim(`${m.server_name} · ${m.upstream_id}`), dim(`tier ${m.tier} · ${caps(m)} ${pick ? `· ${green(pick)}` : ''}`)],
      items: [
        { label: m.enabled ? 'Disable this model' : 'Enable this model', value: 'toggle' },
        { label: 'Edit what it can do (vision, audio, video, tools, reasoning)', value: 'caps', hint: 'fix wrong guesses, e.g. a stripped-down model' },
        { label: 'Rename', value: 'rename' },
      ],
    });
    if (action === null) return;
    if (action === 'toggle') registry.updateModel(id, { enabled: !m.enabled });
    if (action === 'rename') { const n = await ask('New name', m.display_name); registry.updateModel(id, { display_name: n }); }
    if (action === 'caps') {
      const cur = new Set(m.capabilities);
      for (;;) {
        const pickCap = await select({
          title: `What can ${m.display_name} really do?`,
          lines: [dim('enter toggles · esc saves')],
          items: CAPABILITIES.filter((c) => c !== 'text' && c !== 'embedding').map((c) => ({ label: `${cur.has(c) ? green('[x]') : '[ ]'} ${c}`, value: c })),
        });
        if (pickCap === null) break;
        if (cur.has(pickCap)) cur.delete(pickCap); else cur.add(pickCap);
        registry.updateModel(id, { capabilities: ['text', ...cur] });
      }
    }
  }
}

async function allModels(gw) {
  for (;;) {
    const models = chatModels(gw);
    const items = models.map((m) => ({
      label: `${m.enabled ? ' ' : red('✗')} ${m.display_name}`,
      hint: `${m.tier} · ${modelHint(m)}`,
      value: m.id,
    }));
    if (!items.length) { await say(['No models yet. Add a server first.'], { title: 'All models' }); return; }
    const id = await select({ title: 'All models', lines: [dim('enter opens one')], items });
    if (id === null) return;
    await modelDetail(gw, id);
  }
}

async function addServer(gw) {
  const name = await ask('Name for this machine (e.g. Gaming PC)', 'LM Studio');
  let url = await ask('Address (host:port)', 'localhost:1234');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const key = await ask("API token (blank if LM Studio doesn't require one)", '');
  stdout.write(dim('\n  Connecting…\n'));
  const { validation } = await gw.app.registry.addServer({ name, base_url: url, api_key: key, default_tier: 'fast' });
  if (validation.ok) {
    await say([green(`Connected. ${validation.models.length} model(s) found:`), ...validation.models.map((m) => `  • ${m.display_name}  ${dim(caps(m))}`), '', 'Next: Pick your models (Fast and Smart).'], { title: 'Server added' });
  } else {
    await say([red(`Could not reach it: ${validation.error}`), dim('It was saved anyway. In LM Studio: Developer tab → start the server and turn on "Serve on Local Network".')], { title: 'Server added, but offline' });
  }
}

async function servers(gw) {
  const { registry, db } = gw.app;
  for (;;) {
    const list = db.all('SELECT * FROM model_servers ORDER BY name').map((s) => registry.publicServer(s));
    const dot = (s) => (!s.enabled ? dim('○') : s.status === 'healthy' ? green('●') : s.status === 'unhealthy' ? red('●') : yellow('●'));
    const items = list.map((s) => ({ label: `${dot(s)} ${s.name}`, hint: `${s.base_url} · ${s.model_count} models${s.last_error ? ` · ${s.last_error}` : ''}`, value: s.id }));
    items.push({ header: true, label: '' }, { label: 'Add a server', value: '__add' });
    const id = await select({ title: 'Model servers', lines: [dim('● healthy  ● offline  ○ disabled')], items });
    if (id === null) return;
    if (id === '__add') { await addServer(gw); continue; }
    const s = list.find((x) => x.id === id);
    const action = await select({
      title: s.name,
      lines: [dim(s.base_url)],
      items: [
        { label: 'Refresh its model list', value: 'refresh' },
        { label: s.enabled ? 'Disable' : 'Enable', value: 'toggle' },
        { label: 'Change address', value: 'url' },
        { label: red('Remove'), value: 'remove' },
      ],
    });
    if (action === 'refresh') {
      try { const ms = await registry.discover(id); await say([green(`${ms.length} model(s):`), ...ms.map((m) => `  • ${m.display_name}`)], { title: s.name }); }
      catch (e) { await say([red(`Could not reach it: ${e.message}`)], { title: s.name }); }
    }
    if (action === 'toggle') await registry.updateServer(id, { enabled: !s.enabled });
    if (action === 'url') { let u = await ask('New address', s.base_url); if (!/^https?:\/\//i.test(u)) u = `http://${u}`; await registry.updateServer(id, { base_url: u }); }
    if (action === 'remove' && await confirm(`Remove ${s.name} and its models?`)) registry.removeServer(id);
  }
}

async function settingsScreen(gw) {
  const { settings } = gw.app;
  const onoff = (b) => (b ? green('on ') : dim('off'));
  const envOn = (k) => new RegExp(`^\\s*${k}\\s*=\\s*(1|true|yes|on)\\s*$`, 'mi').test(fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '');
  let at = 0;
  for (;;) {
    const items = [
      { header: true, label: 'Memory' },
      { label: `${onoff(settings.get('memory_extraction'))}  Learn about you from chats`, value: 'memory_extraction', hint: 'uses the model that just answered' },
      { label: `${String(settings.get('memory_extract_every')).padEnd(3)}  Look for new memories every N messages`, value: 'memory_extract_every' },
      { label: `${onoff(settings.get('memory_embeddings'))}  Use an embedding model for memory search`, value: 'memory_embeddings', hint: 'off = no second model gets loaded' },
      { header: true, label: 'Chats' },
      { label: `${onoff(settings.get('title_generation'))}  Auto-title chats`, value: 'title_generation' },
      { label: `${String(settings.get('title_regen_every')).padEnd(3)}  Re-check a title every N messages`, value: 'title_regen_every' },
      { header: true, label: 'People' },
      { label: `${onoff(settings.get('open_signup'))}  Anyone on the network can sign up (no invite)`, value: 'open_signup' },
      { header: true, label: 'Needs a gateway restart' },
      { label: `${onoff(envOn('HECATE_DEV_LOGIN'))}  Developer login (testing only)`, value: 'dev_login', hint: 'turn off before exposing the gateway' },
    ];
    const key = await select({ title: 'Settings', items, initial: at });
    if (key === null) return;
    at = items.findIndex((i) => i.value === key);
    if (key === 'dev_login') setEnv('HECATE_DEV_LOGIN', envOn('HECATE_DEV_LOGIN') ? '0' : '1');
    else if (typeof settings.get(key) === 'boolean') settings.set(key, !settings.get(key));
    else { const n = Number(await ask('New value', String(settings.get(key)))); if (n >= 1) settings.set(key, Math.floor(n)); }
  }
}

async function people(gw) {
  const { db } = gw.app;
  for (;;) {
    const action = await select({
      title: 'People',
      items: [
        { label: 'Create an invite code', value: 'invite' },
        { label: 'See who has an account', value: 'users' },
        { label: 'Disable / enable someone', value: 'disable' },
      ],
    });
    if (action === null) return;
    if (action === 'invite') {
      const inv = createInvite(db, { note: await ask('Note (who is it for?)', ''), maxUses: 1, days: 14 });
      await say([`Invite code: ${bold(green(inv.code))}`, dim('One use, valid for 14 days. They enter it when they first sign in.')], { title: 'Invite' });
    }
    if (action === 'users') {
      const rows = db.all('SELECT * FROM users ORDER BY created_at');
      await say(rows.length ? rows.map((u) => `${u.role.padEnd(6)} ${u.disabled ? red('[disabled] ') : ''}${u.display_name ?? '(no name)'} ${dim(u.email ?? '')}`) : ['Nobody has signed in yet. The first person to sign in becomes the owner.'], { title: 'Accounts' });
    }
    if (action === 'disable') {
      const rows = db.all("SELECT * FROM users WHERE role != 'owner' ORDER BY created_at");
      if (!rows.length) { await say(['No other accounts.'], { title: 'People' }); continue; }
      const id = await select({ title: 'Who?', items: rows.map((u) => ({ label: `${u.disabled ? red('✗') : ' '} ${u.display_name ?? u.id}`, value: u.id })) });
      if (id) {
        const u = rows.find((r) => r.id === id);
        db.run('UPDATE users SET disabled = ? WHERE id = ?', !u.disabled, id);
        if (!u.disabled) db.run('UPDATE auth_sessions SET revoked = 1 WHERE user_id = ?', id);
      }
    }
  }
}

function runChild(args) {
  leaveScreen();
  stdin.setRawMode?.(false);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { stdio: 'inherit' });
    child.on('exit', resolve);
  });
}

async function gatewayControl(gw, action) {
  const config = gw.config;
  let r;
  if (action === 'start') r = await daemon.start(config);
  if (action === 'stop') r = await daemon.stop(config);
  if (action === 'restart') r = await daemon.restart(config);
  const addr = daemon.lanAddresses()[0];
  await say([
    r.ok ? green(r.message) : red(r.message),
    ...(r.log ?? []).map((l) => dim(l)),
    ...(r.ok && action !== 'stop' && addr ? ['', `Use this address in the app: ${bold(`http://${addr}:${config.port}`)}`] : []),
  ], { title: 'Gateway' });
}

async function viewLog(gw) {
  const lines = daemon.tailLog(gw.config, 30);
  await say(lines.length ? lines.map((l) => dim(clipTo(l, (stdout.columns || 80) - 4))) : ['The log is empty. (Only a gateway started with `hecate start` writes here.)'], { title: 'Gateway log (last lines)' });
}

async function toggleAutostart(gw) {
  const on = !daemon.autostartInstalled();
  const r = await daemon.setAutostart(gw.config, on);
  await say([r.ok ? green(r.message) : red(r.message)], { title: on ? 'Start at login' : 'Start at login: off' });
}

async function runForeground(gw) {
  if (await probe(gw.config.port)) { await say([yellow(`A gateway is already running on port ${gw.config.port}. Stop it first.`)], { title: 'Run in this window' }); return; }
  leaveScreen();
  gw.db.close();
  stdout.write(`${dim('Running the gateway in this window. Press Ctrl-C to stop it.')}\n\n`);
  await runChild(['src/server.js']);
  throw new Quit();
}

async function backup(gw) {
  const file = path.join(gw.config.dataDir, 'backups', `hecate-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  gw.db.backupTo(file);
  await say([green('Database backed up:'), file, '', dim(`Also copy ${path.join(gw.config.dataDir, 'files')} to back up attachments.`)], { title: 'Backup' });
}

// ------------------------------------------------------------------ main menu

async function hermesScreen(gw) {
  const { settings, hermes } = gw.app;
  let note = '';
  let at = 0;
  for (;;) {
    const url = settings.get('hermes_url');
    const st = url ? await hermes.status() : { attached: false };
    const state = !url ? dim('not connected')
      : st.reachable ? green('connected') : red(`not reachable${st.error ? ` (${st.error})` : st.http_status ? ` (HTTP ${st.http_status})` : ''}`);
    const lines = [
      bold('Hermes Agent'),
      `${url ? url : dim('no address set')}   ${state}`,
      ...(note ? ['', note] : []),
      '',
      dim('Hermes must have its API server on (API_SERVER_ENABLED=true, usually port 8642). Agents in the app run through it.'),
      '',
    ];
    const items = [
      ...(hermesInstalledLocally() ? [{ label: 'Set up automatically (Hermes is on this machine)', hint: 'turns on its API and connects', value: 'auto' }] : []),
      { label: url ? 'Change the address or key' : 'Connect Hermes', value: 'connect' },
      ...(url ? [{ label: 'Test the connection', value: 'test' }, { label: 'Disconnect', value: 'off' }] : []),
      { label: 'Back', value: 'back' },
    ];
    const choice = await select({ lines, items, initial: at, footer: '↑↓ move   enter choose   q back' });
    if (choice === null || choice === 'back') return;
    at = items.findIndex((i) => i.value === choice);
    note = '';
    if (choice === 'auto') {
      const r = enableLocalHermesApi();
      if (r.ok) { hermes.attach({ url: r.url, api_key: r.api_key }); const s2 = await hermes.status(); note = s2.reachable ? green(`${r.message} Connected.`) : yellow(`${r.message} Not answering yet; give it a few seconds and choose Test.`); }
      else note = yellow(r.message);
    } else if (choice === 'connect') {
      const addr = await ask('Hermes API address', url || 'http://localhost:8642');
      const key = await ask('API key (API_SERVER_KEY; blank to keep the current one, "-" for none)', '');
      hermes.attach({ url: addr, ...(key === '-' ? { api_key: '' } : key ? { api_key: key } : {}) });
      const s2 = await hermes.status();
      note = s2.reachable ? green('Connected.') : yellow(`Saved, but Hermes did not answer${s2.error ? `: ${s2.error}` : s2.http_status ? ` (HTTP ${s2.http_status})` : ''}. Check that it is running with its API server on.`);
    } else if (choice === 'test') {
      const s2 = await hermes.status();
      note = s2.reachable ? green('Hermes answered.') : red(`No answer${s2.error ? `: ${s2.error}` : s2.http_status ? ` (HTTP ${s2.http_status})` : ''}.`);
    } else if (choice === 'off') {
      if (await confirm('Disconnect Hermes? Agents will stop working until you connect it again.', false)) { hermes.attach({ url: '', api_key: '' }); note = dim('Disconnected.'); }
    }
  }
}

async function menu(gw) {
  let at = 0;
  for (;;) {
    const port = gw.config.port;
    const st = await daemon.status(gw.config);
    const auto = daemon.autostartInstalled();
    const addr = daemon.lanAddresses()[0];
    const fast = pickedName(gw, 'model_fast'), smart = pickedName(gw, 'model_smart');
    const lines = [
      `${st.running ? green('● running') : red('● stopped')}  ${dim(st.running ? `port ${port}${addr ? ` · http://${addr}:${port}` : ''}${st.ownedByUs ? '' : ' · started elsewhere (not by hecate)'}` : 'choose “Start the gateway”')}`,
      `${bold('Fast')} ${fast ?? dim('not picked')}   ${bold('Smart')} ${smart ?? dim('not picked')}`,
      '',
      bold('What do you want to do?'),
    ];
    const items = [
      { label: 'Pick your models', hint: 'choose the Fast and Smart model', value: 'pick' },
      ...(st.running
        ? [{ label: 'Stop the gateway', value: 'stop' }, { label: 'Restart the gateway', value: 'restart' }]
        : [{ label: 'Start the gateway', hint: 'runs in the background; closing this window is fine', value: 'start' }]),
      { label: 'View the gateway log', value: 'log' },
      ...(daemon.autostartSupported() ? [{ label: `Start automatically at login: ${auto ? green('on') : dim('off')}`, hint: 'keeps it running after restarts', value: 'autostart' }] : []),
      { label: 'Model servers', hint: 'LM Studio machines: add, refresh, remove', value: 'servers' },
      { label: 'All models', hint: 'enable/disable, fix what each can do', value: 'models' },
      { label: 'Hermes agent', hint: gw.app.settings.get('hermes_url') ? 'connected setup, test, change' : 'connect it so agents work', value: 'hermes' },
      { label: 'Settings', hint: 'memory, titles, sign-in', value: 'settings' },
      { label: 'People', hint: 'invites and accounts', value: 'people' },
      { label: 'Back up the database', value: 'backup' },
      { header: true, label: '' },
      { label: dim('Run in this window (live log)'), value: 'foreground' },
      { label: dim('Run the setup wizard again'), value: 'setup' },
      { label: 'Quit', value: 'quit' },
    ];
    const choice = await select({ lines, items, initial: at, footer: '↑↓ move   enter choose   q quit' });
    if (choice === null || choice === 'quit') return;
    at = items.findIndex((i) => i.value === choice);
    if (choice === 'pick') await pickModels(gw);
    if (['start', 'stop', 'restart'].includes(choice)) await gatewayControl(gw, choice);
    if (choice === 'log') await viewLog(gw);
    if (choice === 'autostart') await toggleAutostart(gw);
    if (choice === 'servers') await servers(gw);
    if (choice === 'models') await allModels(gw);
    if (choice === 'hermes') await hermesScreen(gw);
    if (choice === 'settings') await settingsScreen(gw);
    if (choice === 'people') await people(gw);
    if (choice === 'backup') await backup(gw);
    if (choice === 'foreground') await runForeground(gw);
    if (choice === 'setup') { gw.db.close(); await runChild(['src/setup.js']); throw new Quit(); }
  }
}

// ------------------------------------------------------------------ non-interactive commands

function printModels(gw) {
  const fast = gw.app.settings.get('model_fast'), smart = gw.app.settings.get('model_smart');
  for (const m of chatModels(gw)) {
    const tag = m.id === fast && m.id === smart ? 'FAST+SMART' : m.id === fast ? 'FAST' : m.id === smart ? 'SMART' : '';
    console.log(`${tag.padEnd(10)} ${m.enabled ? ' ' : '✗'} ${m.display_name}  (${modelHint(m)})`);
  }
}

const HELP = `hecate — control the Hecate Gateway from any folder

  hecate              open the menu (also: hecate gateway)
  hecate start        start the gateway in the background (keeps running when you close the window)
  hecate stop         stop it
  hecate restart      restart it
  hecate status       what's running, which models are picked, where to point the app
  hecate logs         show the gateway log        (hecate logs -f   follows it live)
  hecate autostart on|off   start automatically at login (macOS launchd / Linux systemd)
  hecate models       pick your Fast and Smart models
  hecate hermes       connect or test the Hermes agent
  hecate list         list models and which are picked
  hecate setup        run the setup wizard
  hecate help         this text`;

export async function main(args) {
  const cmd = args[0];
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  const config = loadConfig({});

  // Commands that only need the process, not the database.
  if (cmd === 'start' || cmd === 'stop' || cmd === 'restart') {
    const r = await daemon[cmd](config);
    console.log(r.message);
    for (const l of r.log ?? []) console.log(`  ${l}`);
    if (r.ok && cmd !== 'stop') {
      const addr = daemon.lanAddresses()[0];
      console.log(`Address for the app: http://${addr ?? 'localhost'}:${config.port}`);
      if (!r.already && cmd === 'start') console.log('Stop it with: hecate stop   ·   Logs: hecate logs -f');
    }
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'logs') { await daemon.logs(config, { follow: args.includes('-f') || args.includes('--follow') }); return; }
  if (cmd === 'autostart') {
    const arg = args[1];
    if (arg !== 'on' && arg !== 'off') { console.log(`Start at login is ${daemon.autostartInstalled() ? 'ON' : 'off'}. Use: hecate autostart on|off`); return; }
    const r = await daemon.setAutostart(config, arg === 'on');
    console.log(r.message);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (cmd === 'setup') {
    const { runSetup, makeIO } = await import('./setup.js');
    const io = makeIO();
    const r = await runSetup({ io });
    io.close();
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

  // First run: `hecate` / `hecate gateway` with no .env walks through setup, then starts in the background.
  if ((!cmd || cmd === 'gateway' || cmd === 'menu') && stdout.isTTY && stdin.isTTY && !fs.existsSync(path.join(daemon.ROOT, '.env'))) {
    const { runSetup, makeIO } = await import('./setup.js');
    const io = makeIO();
    const r = await runSetup({ io, cwd: daemon.ROOT });
    if (!r.ok) { io.close(); process.exitCode = 1; return; }
    const cfg = loadConfig({});
    if (daemon.autostartSupported() && await io.yes('\nKeep the gateway running in the background and start it automatically at login/boot?', true)) {
      const a = await daemon.setAutostart(cfg, true);
      console.log(a.message);
      if (!a.ok) await daemon.start(cfg);
    } else {
      await daemon.start(cfg);
    }
    io.close();
    console.log('\nAll set. Run `hecate` any time to manage it (models, people, Hermes, logs).');
    return;
  }

  const gw = createGateway({ logLevel: 'error' });
  try {
    if (cmd === 'list') { printModels(gw); return; }
    if (cmd === 'status') {
      const st = await daemon.status(config);
      const addr = daemon.lanAddresses()[0];
      console.log(`${st.running ? 'running' : 'stopped'}${st.pid ? ` (pid ${st.pid})` : ''}  port ${config.port}${st.running && addr ? `  http://${addr}:${config.port}` : ''}`);
      console.log(`start at login: ${daemon.autostartInstalled() ? 'on' : 'off'}`);
      console.log(`fast:  ${pickedName(gw, 'model_fast') ?? '(not picked)'}\nsmart: ${pickedName(gw, 'model_smart') ?? '(not picked)'}`);
      return;
    }
    if (!stdout.isTTY || !stdin.isTTY) { console.log(HELP); return; }
    if (cmd === 'models') { await pickModels(gw); return; }
    if (cmd === 'hermes') { await hermesScreen(gw); return; }
    if (cmd && cmd !== 'menu' && cmd !== 'gateway') { console.log(HELP); return; }
    await menu(gw);
  } catch (e) {
    if (!(e instanceof Quit)) { leaveScreen(); console.error(red(`\nSomething went wrong: ${e.message}`)); process.exitCode = 1; }
  } finally {
    leaveScreen();
    try { gw.db.close(); } catch { /* already closed */ }
    stdin.pause();
  }
}
