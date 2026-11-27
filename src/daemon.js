// Runs the gateway as a background process you control with `hecate start|stop|restart|status|logs`,
// and can register it to start automatically at login (launchd on macOS, systemd --user on Linux).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'app.hecate.gateway';
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function files(config) {
  return { pid: path.join(config.dataDir, 'gateway.pid'), log: path.join(config.dataDir, 'gateway.log') };
}

export function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readPid(config) {
  try { return Number(fs.readFileSync(files(config).pid, 'utf8').trim()) || null; } catch { return null; }
}
export async function probe(port, ms = 800) {
  try { return (await fetch(`http://127.0.0.1:${port}/v1/capabilities`, { signal: AbortSignal.timeout(ms) })).ok; } catch { return false; }
}
export function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
export function tailLog(config, lines = 40) {
  try { return fs.readFileSync(files(config).log, 'utf8').split('\n').filter(Boolean).slice(-lines); } catch { return []; }
}

// ------------------------------------------------------------------ autostart (launchd / systemd --user)

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitPath = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'hecate-gateway.service');
const uid = () => process.getuid?.() ?? 501;
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function autostartSupported() { return isMac || isLinux; }
export function autostartInstalled() { return isMac ? fs.existsSync(plistPath()) : isLinux ? fs.existsSync(unitPath()) : false; }

export function renderPlist(config) {
  const { log } = files(config);
  const args = [process.execPath, ...NODE_FLAGS, path.join(ROOT, 'src', 'server.js')];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string></dict>
</dict>
</plist>
`;
}
export function renderUnit(config) {
  return `[Unit]
Description=Hecate Gateway
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory="${ROOT}"
ExecStart="${process.execPath}" ${NODE_FLAGS.join(' ')} "${path.join(ROOT, 'src', 'server.js')}"
Restart=on-failure
RestartSec=3
StandardOutput=append:${files(config).log}
StandardError=append:${files(config).log}

[Install]
WantedBy=default.target
`;
}

/** Turn "start at login" on or off. Returns a human-readable result line. */
/** macOS blocks background login items from reading Desktop, Documents and Downloads. */
export function protectedFolderWarning(config) {
  if (!isMac) return null;
  const home = os.homedir();
  for (const dir of ['Desktop', 'Documents', 'Downloads']) {
    const base = path.join(home, dir) + path.sep;
    if (ROOT.startsWith(base) || config.dataDir.startsWith(base)) {
      return `The gateway lives in ~/${dir}, which macOS does not let background login items read, so start-at-login would fail. Move the whole hecate-gateway folder to your home folder (for example ~/hecate-gateway), run \`npm link\` there again, and then turn this on.`;
    }
  }
  return null;
}

export async function setAutostart(config, on) {
  if (!autostartSupported()) return { ok: false, message: 'Start-at-login is only supported on macOS and Linux. Use Docker or a service manager on this system.' };
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (on) {
    const warn = protectedFolderWarning(config);
    if (warn) return { ok: false, message: warn };
    await stop(config, { quiet: true });                 // hand over from a plain background process
    if (isMac) {
      fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
      fs.writeFileSync(plistPath(), renderPlist(config));
      run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
      const r = run('launchctl', ['bootstrap', `gui/${uid()}`, plistPath()]);
      if (r.status !== 0) return { ok: false, message: `launchctl failed: ${(r.stderr || r.stdout).trim()}` };
      return { ok: true, message: 'The gateway will now start automatically when you log in, and restart itself if it crashes.' };
    }
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), renderUnit(config));
    run('systemctl', ['--user', 'daemon-reload']);
    const r = run('systemctl', ['--user', 'enable', '--now', 'hecate-gateway.service']);
    if (r.status !== 0) return { ok: false, message: `systemctl failed: ${(r.stderr || r.stdout).trim()}` };
    // Keep the user service alive after logout and across reboots (usually allowed without sudo).
    const user = os.userInfo().username;
    let linger = run('loginctl', ['enable-linger', user]).status === 0;
    if (!linger) linger = run('loginctl', ['show-user', user, '-p', 'Linger']).stdout.includes('Linger=yes');
    return { ok: true, message: linger
      ? 'Started and enabled. It keeps running after you log out and comes back after a reboot.'
      : `Started and enabled, but it will stop when you log out. Run once to fix that:  sudo loginctl enable-linger ${user}` };
  }
  if (isMac) { run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]); fs.rmSync(plistPath(), { force: true }); }
  else { run('systemctl', ['--user', 'disable', '--now', 'hecate-gateway.service']); fs.rmSync(unitPath(), { force: true }); run('systemctl', ['--user', 'daemon-reload']); }
  return { ok: true, message: 'Start-at-login is off. The gateway is stopped; run `hecate start` to run it again.' };
}

// ------------------------------------------------------------------ start / stop / status

export async function status(config) {
  const pid = readPid(config);
  const responding = await probe(config.port);
  const managed = autostartInstalled();
  return { running: responding, pid: alive(pid) ? pid : null, port: config.port, managed, ownedByUs: Boolean(alive(pid)) || managed };
}

function serviceStart() {
  if (isMac) {
    const loaded = run('launchctl', ['print', `gui/${uid()}/${LABEL}`]).status === 0;
    if (!loaded) return run('launchctl', ['bootstrap', `gui/${uid()}`, plistPath()]);
    return run('launchctl', ['kickstart', '-k', `gui/${uid()}/${LABEL}`]);
  }
  return run('systemctl', ['--user', 'start', 'hecate-gateway.service']);
}
function serviceStop() {
  return isMac ? run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]) : run('systemctl', ['--user', 'stop', 'hecate-gateway.service']);
}

export async function start(config) {
  const s = await status(config);
  if (s.running) return { ok: true, already: true, message: `The gateway is already running on port ${config.port}.` };
  if (s.managed) {
    const r = serviceStart();
    if (r.status !== 0) return { ok: false, message: `Could not start the service: ${(r.stderr || r.stdout).trim()}` };
  } else {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const { pid: pidFile, log } = files(config);
    try { if (fs.statSync(log).size > 5_000_000) fs.renameSync(log, `${log}.1`); } catch { /* no log yet */ }
    const out = fs.openSync(log, 'a');
    const child = spawn(process.execPath, [...NODE_FLAGS, path.join(ROOT, 'src', 'server.js')], {
      cwd: ROOT, detached: true, stdio: ['ignore', out, out], env: process.env,
    });
    child.unref();
    fs.writeFileSync(pidFile, String(child.pid));
  }
  for (let i = 0; i < 40; i++) {            // wait up to ~10 s for it to answer
    await sleep(250);
    if (await probe(config.port, 500)) return { ok: true, message: `The gateway is running in the background on port ${config.port}.` };
    if (!s.managed && !alive(readPid(config))) break;
  }
  return { ok: false, message: 'The gateway did not come up. Last lines of its log:', log: tailLog(config, 12) };
}

export async function stop(config, { quiet = false } = {}) {
  const s = await status(config);
  if (s.managed) {
    serviceStop();
    for (let i = 0; i < 30 && await probe(config.port, 400); i++) await sleep(250);
    return { ok: true, message: 'Stopped. It will start again at your next login (turn that off with: hecate autostart off).' };
  }
  const pid = readPid(config);
  if (alive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(files(config).pid, { force: true });
    return { ok: true, message: 'The gateway is stopped.' };
  }
  fs.rmSync(files(config).pid, { force: true });
  if (await probe(config.port)) {
    return { ok: false, message: `Something is answering on port ${config.port} but it was not started by hecate (for example \`npm run dev\` in another window). Stop it there with Ctrl-C.` };
  }
  return { ok: true, message: quiet ? '' : 'The gateway is not running.' };
}

export async function restart(config) {
  const s = await status(config);
  if (s.running && !s.ownedByUs) return { ok: false, message: `The gateway on port ${config.port} was not started by hecate. Stop it where it is running, then use \`hecate start\`.` };
  await stop(config, { quiet: true });
  return start(config);
}

/** Print the log, and with follow=true keep printing new lines until Ctrl-C. */
export async function logs(config, { follow = false, lines = 50 } = {}) {
  const { log } = files(config);
  for (const l of tailLog(config, lines)) console.log(l);
  if (!follow) return;
  let pos = 0;
  try { pos = fs.statSync(log).size; } catch { /* created later */ }
  for (;;) {
    await sleep(500);
    let size = 0;
    try { size = fs.statSync(log).size; } catch { continue; }
    if (size < pos) pos = 0;
    if (size > pos) {
      const fd = fs.openSync(log, 'r');
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      process.stdout.write(buf.toString('utf8'));
      pos = size;
    }
  }
}
