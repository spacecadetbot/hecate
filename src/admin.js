import crypto from 'node:crypto';
import fs from 'node:fs';
import { err, newId, now, iso, sha256hex, randomToken } from './util.js';
import { created } from './http.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function makeInviteCode() {
  const b = crypto.randomBytes(8);
  const c = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
export function createInvite(db, { createdBy = null, note = null, maxUses = 1, days = 14 } = {}) {
  const code = makeInviteCode();
  db.run('INSERT INTO invites(code, created_by, note, max_uses, expires_at, created_at) VALUES(?,?,?,?,?,?)',
    code, createdBy, note, maxUses, days ? now() + days * 86400_000 : null, now());
  return db.get('SELECT * FROM invites WHERE code = ?', code);
}
const invitePub = (i) => ({ code: i.code, note: i.note, max_uses: i.max_uses, uses: i.uses, expires_at: iso(i.expires_at), created_at: iso(i.created_at), revoked: Boolean(i.revoked) });

export function registerAdmin(r, app) {
  const { db, config, auth, settings, registry, media, runs, hermes, secrets } = app;
  const A = { auth: 'admin' };
  const isOwner = (u) => u.role === 'owner';

  r.get('/v1/admin/status', () => ({
    version: config.version, users: db.get('SELECT COUNT(*) AS c FROM users').c, active_runs: runs.active.size,
    servers: db.all('SELECT * FROM model_servers').map((s) => registry.publicServer(s)),
    media: { ffmpeg: config.ffmpeg, pdftotext: config.pdftotext, unzip: config.unzip },
    hermes: { attached: hermes.isConfigured() },
    node: process.version, uptime_sec: Math.round(process.uptime()),
  }), A);

  // ----- model servers -----
  r.get('/v1/admin/servers', () => ({ servers: db.all('SELECT * FROM model_servers ORDER BY name').map((s) => registry.publicServer(s)) }), A);
  r.post('/v1/admin/servers', async (c) => created(await registry.addServer(c.body)), A);
  r.get('/v1/admin/servers/:id', (c) => registry.publicServer(registry.getServer(c.params.id)), A);
  r.patch('/v1/admin/servers/:id', async (c) => registry.updateServer(c.params.id, c.body), A);
  r.delete('/v1/admin/servers/:id', (c) => { registry.removeServer(c.params.id); }, A);
  r.post('/v1/admin/servers/:id/validate', async (c) => {
    try { return { ok: true, models: await registry.discover(c.params.id) }; }
    catch (e) { return { ok: false, error: e.message }; }
  }, A);
  r.get('/v1/admin/models', () => ({ models: registry.listAdminModels() }), A);
  r.patch('/v1/admin/models/:id', (c) => registry.updateModel(c.params.id, c.body), A);

  r.put('/v1/admin/model-picks', (c) => {
    const out = {};
    for (const tier of ['fast', 'smart']) {
      if (!(tier in c.body)) continue;
      const id = c.body[tier];
      if (id === null || id === '') { settings.set(`model_${tier}`, ''); continue; }
      const m = registry.listPublicModels().find((x) => x.id === id);
      if (!m) throw err(400, 'invalid_request', `${tier}: unknown or non-chat model`);
      settings.set(`model_${tier}`, id);
      registry.updateModel(id, { tier });
    }
    out.fast = settings.get('model_fast') || null;
    out.smart = settings.get('model_smart') || null;
    return out;
  }, A);

  // ----- users -----
  r.get('/v1/admin/users', () => ({
    users: db.all('SELECT * FROM users ORDER BY created_at').map((u) => ({ ...auth.publicUser(u), disabled: Boolean(u.disabled), last_seen_at: iso(u.last_seen_at) })),
  }), A);
  r.patch('/v1/admin/users/:id', (c) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', c.params.id);
    if (!u) throw err(404, 'not_found', 'User not found');
    if (u.role === 'owner' && u.id !== c.user.id) throw err(403, 'forbidden', 'The owner cannot be modified');
    if ('role' in c.body) {
      if (!isOwner(c.user)) throw err(403, 'forbidden', 'Only the owner can change roles');
      if (!['user', 'admin'].includes(c.body.role)) throw err(400, 'invalid_request', 'role must be "user" or "admin"');
      db.run('UPDATE users SET role = ? WHERE id = ?', c.body.role, u.id);
    }
    if ('disabled' in c.body) {
      if (u.id === c.user.id) throw err(400, 'invalid_request', 'You cannot disable yourself');
      db.run('UPDATE users SET disabled = ? WHERE id = ?', Boolean(c.body.disabled), u.id);
      if (c.body.disabled) { runs.cancelUser(u.id); db.run('UPDATE auth_sessions SET revoked = 1 WHERE user_id = ?', u.id); }
    }
    return auth.publicUser(db.get('SELECT * FROM users WHERE id = ?', u.id));
  }, A);
  r.delete('/v1/admin/users/:id', (c) => {
    const u = db.get('SELECT * FROM users WHERE id = ?', c.params.id);
    if (!u) throw err(404, 'not_found', 'User not found');
    if (u.role === 'owner') throw err(403, 'forbidden', 'The owner cannot be deleted');
    runs.cancelUser(u.id);
    for (const a of db.all('SELECT * FROM attachments WHERE user_id = ?', u.id)) media.removeFiles(a);
    db.tx(() => {
      db.run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE user_id = ?)', u.id);
      db.run('DELETE FROM runs WHERE user_id = ?', u.id);
      db.run('DELETE FROM users WHERE id = ?', u.id);
    });
  }, A);

  // ----- invites -----
  r.get('/v1/admin/invites', () => ({ invites: db.all('SELECT * FROM invites ORDER BY created_at DESC').map(invitePub) }), A);
  r.post('/v1/admin/invites', (c) => created(invitePub(createInvite(db, {
    createdBy: c.user.id, note: c.body.note ?? null, maxUses: Math.max(1, Number(c.body.max_uses ?? 1)), days: c.body.expires_in_days === 0 ? 0 : Number(c.body.expires_in_days ?? 14),
  }))), A);
  r.delete('/v1/admin/invites/:code', (c) => { db.run('UPDATE invites SET revoked = 1 WHERE code = ?', c.params.code); }, A);

  // ----- service API keys (for /openai/v1, e.g. Hermes) -----
  r.get('/v1/admin/api-keys', () => ({
    api_keys: db.all('SELECT * FROM api_keys WHERE revoked = 0 ORDER BY created_at DESC').map((k) => ({ id: k.id, name: k.name, created_at: iso(k.created_at), last_used_at: iso(k.last_used_at) })),
  }), A);
  r.post('/v1/admin/api-keys', (c) => {
    const key = randomToken('hk', 24); const id = newId('key');
    db.run('INSERT INTO api_keys(id, name, key_hash, created_by, created_at) VALUES(?,?,?,?,?)', id, String(c.body.name ?? 'service key').slice(0, 80), sha256hex(key), c.user.id, now());
    return created({ id, name: c.body.name ?? 'service key', key, note: 'Copy this key now; it will not be shown again.' });
  }, A);
  r.delete('/v1/admin/api-keys/:id', (c) => { db.run('UPDATE api_keys SET revoked = 1 WHERE id = ?', c.params.id); }, A);

  // ----- settings & Hermes -----
  r.get('/v1/admin/settings', () => settings.all(), A);
  r.patch('/v1/admin/settings', (c) => {
    const ok = settings.editableKeys();
    for (const [k, v] of Object.entries(c.body)) {
      if (!ok.includes(k)) throw err(400, 'invalid_request', `Unknown or read-only setting "${k}"`);
      if (k === 'hermes_url') continue;
      settings.set(k, v);
    }
    if ('hermes_url' in c.body) hermes.attach({ url: c.body.hermes_url });
    return settings.all();
  }, A);
  r.get('/v1/admin/hermes', async () => hermes.status(), A);
  r.post('/v1/admin/hermes', async (c) => {
    if (!c.body.url) throw err(400, 'invalid_request', 'url is required, e.g. http://localhost:8642');
    if (c.body.mode && !['completions', 'sessions'].includes(c.body.mode)) throw err(400, 'invalid_request', 'mode must be "completions" or "sessions"');
    hermes.attach(c.body);
    return hermes.status();
  }, A);
  r.delete('/v1/admin/hermes', () => { hermes.attach({ url: '', api_key: '' }); }, A);

  // ----- backup -----
  r.post('/v1/admin/backup', (c) => {
    const dir = `${config.dataDir}/backups`;
    fs.mkdirSync(dir, { recursive: true });
    const file = `${dir}/hecate-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    db.backupTo(file);
    return { file, size: fs.statSync(file).size };
  }, A);
}
