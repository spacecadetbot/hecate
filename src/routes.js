import fs from 'node:fs';
import { err, newId, now, iso, parseJson, slugify, truncate } from './util.js';
import { Reply, created, openSSE } from './http.js';
import { EVENT_TYPES, isTerminal } from './runs.js';
import { TIERS } from './servers.js';

const int = (v, d, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Math.trunc(Number(v)) : d));
const str = (v, name, max = 200) => {
  if (typeof v !== 'string') throw err(400, 'invalid_request', `${name} must be a string`);
  if (v.length > max) throw err(400, 'invalid_request', `${name} is too long (max ${max})`);
  return v;
};

export function registerRoutes(r, app) {
  const { db, config, auth, settings, registry, media, memory, runs, hermes, limiter } = app;

  const chatPub = (c) => ({
    id: c.id, title: c.title, pinned: Boolean(c.pinned), agent_id: c.agent_id, model_prefs: parseJson(c.model_prefs, {}),
    use_memory: Boolean(c.use_memory), system_prompt: c.system_prompt, created_at: iso(c.created_at), updated_at: iso(c.updated_at),
    active_run_id: runs.activeRunForChat(c.id),
  });
  const getChat = (id, user) => {
    const c = db.get('SELECT * FROM chats WHERE id = ?', id);
    if (!c || c.user_id !== user.id) throw err(404, 'not_found', 'Chat not found');
    return c;
  };
  const agentPub = (a) => ({
    id: a.id, name: a.name, description: a.description, persona: a.persona, tier: a.tier, model_id: a.model_id, tools: parseJson(a.tools, []),
    hermes_profile: a.hermes_profile, has_api_key: Boolean(a.hermes_api_key_enc), enabled: Boolean(a.enabled), created_at: iso(a.created_at), updated_at: iso(a.updated_at),
  });
  const runParams = (b) => {
    if (b.tier !== undefined && !TIERS.includes(b.tier)) throw err(400, 'invalid_request', `tier must be one of ${TIERS.join(', ')}`);
    return { tier: b.tier, model_id: b.model_id, think_harder: Boolean(b.think_harder) };
  };

  // ---------- discovery ----------
  r.get('/healthz', () => ({ ok: true }), { auth: 'none' });
  r.get('/v1/capabilities', () => {
    const users = db.get('SELECT COUNT(*) AS c FROM users').c;
    return {
      name: config.name, version: config.version, api_version: config.apiVersion,
      features: ['chats', 'sse_streaming', 'resumable_runs', 'think_harder', 'attachments', 'memory', 'agents', 'model_registry', 'openai_passthrough'],
      auth: { apple: Boolean(config.appleBundleId), dev: config.devLogin, invite_required: users > 0 && !settings.get('open_signup'), needs_owner: users === 0 },
      tiers: TIERS, events: EVENT_TYPES,
      limits: { max_upload_bytes: config.maxUploadBytes, context_chars: config.contextChars },
      media: { ffmpeg: config.ffmpeg, pdf_text: config.pdftotext, transcription: Boolean(settings.get('stt_url')), embeddings: Boolean(registry.embeddingTarget()) },
      agents: { hermes_attached: hermes.isConfigured() },
    };
  }, { auth: 'none' });

  // ---------- auth ----------
  const ipKey = (c) => `auth:${c.req.socket.remoteAddress}`;
  r.post('/v1/auth/apple', async (c) => {
    limiter.check(ipKey(c), 30, 60_000);
    const b = c.body;
    const claims = await auth.verifyAppleIdentityToken(b.identity_token, b.nonce);
    const user = auth.loginOrRegister({ sub: claims.sub, email: claims.email, fullName: b.full_name ? truncate(String(b.full_name), 100) : null, inviteCode: b.invite_code });
    return auth.openSession(user, b.device_name);
  }, { auth: 'none' });
  r.post('/v1/auth/dev', (c) => {
    if (!config.devLogin) throw err(404, 'not_found', 'Developer login is disabled');
    limiter.check(ipKey(c), 30, 60_000);
    const name = str(c.body.name ?? 'dev', 'name', 60);
    const user = auth.loginOrRegister({ sub: `dev:${name}`, email: null, fullName: name, inviteCode: c.body.invite_code });
    return auth.openSession(user, c.body.device_name ?? 'dev');
  }, { auth: 'none' });
  r.post('/v1/auth/refresh', (c) => { limiter.check(ipKey(c), 60, 60_000); return auth.refresh(c.body.refresh_token); }, { auth: 'none' });
  r.post('/v1/auth/logout', (c) => { auth.revokeSession(c.sessionId, c.user.id); });

  // ---------- me ----------
  r.get('/v1/me', (c) => auth.publicUser(c.user));
  r.patch('/v1/me', (c) => {
    if ('display_name' in c.body) db.run('UPDATE users SET display_name = ? WHERE id = ?', str(c.body.display_name, 'display_name', 100), c.user.id);
    if ('show_disclaimer' in c.body) {
      if (typeof c.body.show_disclaimer !== 'boolean') throw err(400, 'invalid_request', 'show_disclaimer must be true or false');
      db.run('UPDATE users SET show_disclaimer = ? WHERE id = ?', c.body.show_disclaimer ? 1 : 0, c.user.id);
    }
    return auth.publicUser(db.get('SELECT * FROM users WHERE id = ?', c.user.id));
  });
  r.delete('/v1/me', (c) => {
    runs.cancelUser(c.user.id);
    for (const a of db.all('SELECT * FROM attachments WHERE user_id = ?', c.user.id)) media.removeFiles(a);
    db.tx(() => {
      db.run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE user_id = ?)', c.user.id);
      db.run('DELETE FROM runs WHERE user_id = ?', c.user.id);
      db.run('DELETE FROM users WHERE id = ?', c.user.id);
    });
  });
  r.get('/v1/me/sessions', (c) => ({
    sessions: db.all('SELECT * FROM auth_sessions WHERE user_id = ? AND revoked = 0 AND expires_at > ? ORDER BY last_used_at DESC', c.user.id, now())
      .map((s) => ({ id: s.id, device_name: s.device_name, created_at: iso(s.created_at), last_used_at: iso(s.last_used_at), current: s.id === c.sessionId })),
  }));
  r.delete('/v1/me/sessions/:id', (c) => { auth.revokeSession(c.params.id, c.user.id); });

  // ---------- chats ----------
  r.get('/v1/chats', (c) => {
    const limit = int(c.query.limit, 50, 1, 200); const offset = int(c.query.offset, 0, 0, 1e9);
    const q = c.query.q ? `%${String(c.query.q).replace(/[\\%_]/g, '\\$&')}%` : null;
    const rows = db.all(
      `SELECT * FROM chats WHERE user_id = ? AND (? IS NULL OR agent_id = ?) AND (? IS NULL OR title LIKE ? ESCAPE '\\')
       ORDER BY pinned DESC, updated_at DESC LIMIT ? OFFSET ?`, c.user.id, c.query.agent_id ?? null, c.query.agent_id ?? null, q, q, limit + 1, offset);
    return { chats: rows.slice(0, limit).map(chatPub), has_more: rows.length > limit };
  });
  r.post('/v1/chats', (c) => {
    const b = c.body;
    if (b.agent_id) {
      const a = db.get('SELECT * FROM agents WHERE id = ? AND user_id = ?', b.agent_id, c.user.id);
      if (!a) throw err(404, 'not_found', 'Agent not found');
    }
    const id = newId('cht');
    db.run('INSERT INTO chats(id, user_id, title, agent_id, model_prefs, use_memory, system_prompt, hermes_session_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, c.user.id, b.title ? str(b.title, 'title') : 'New chat', b.agent_id ?? null, JSON.stringify(b.model_prefs ?? {}),
      b.use_memory === false ? 0 : 1, b.system_prompt ? str(b.system_prompt, 'system_prompt', 20000) : null, b.agent_id ? `hecate-${id}` : null, now(), now());
    return created(chatPub(db.get('SELECT * FROM chats WHERE id = ?', id)));
  });
  r.get('/v1/chats/:id', (c) => chatPub(getChat(c.params.id, c.user)));
  r.patch('/v1/chats/:id', (c) => {
    const chat = getChat(c.params.id, c.user); const b = c.body;
    const prefs = b.model_prefs ?? parseJson(chat.model_prefs, {});
    if (prefs.tier !== undefined && !TIERS.includes(prefs.tier)) throw err(400, 'invalid_request', `tier must be one of ${TIERS.join(', ')}`);
    db.run('UPDATE chats SET title=?, pinned=?, model_prefs=?, use_memory=?, system_prompt=? WHERE id=?',
      'title' in b ? str(b.title, 'title') : chat.title, 'pinned' in b ? Boolean(b.pinned) : chat.pinned, JSON.stringify(prefs),
      'use_memory' in b ? Boolean(b.use_memory) : chat.use_memory, 'system_prompt' in b ? (b.system_prompt ? str(b.system_prompt, 'system_prompt', 20000) : null) : chat.system_prompt, chat.id);
    return chatPub(db.get('SELECT * FROM chats WHERE id = ?', chat.id));
  });
  r.delete('/v1/chats/:id', (c) => {
    const chat = getChat(c.params.id, c.user);
    runs.cancelChat(chat.id);
    for (const a of db.all('SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.chat_id = ?', chat.id)) media.removeFiles(a);
    db.tx(() => {
      db.run('DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE chat_id = ?)', chat.id);
      db.run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE chat_id = ?)', chat.id);
      db.run('DELETE FROM runs WHERE chat_id = ?', chat.id);
      db.run('DELETE FROM chats WHERE id = ?', chat.id);
    });
  });
  r.get('/v1/chats/:id/messages', (c) => {
    const chat = getChat(c.params.id, c.user);
    const limit = int(c.query.limit, 50, 1, 200);
    const before = c.query.before_seq ? Number(c.query.before_seq) : Number.MAX_SAFE_INTEGER;
    const rows = db.all('SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', chat.id, before, limit + 1);
    const page = rows.slice(0, limit).reverse();
    const msgs = runs.publicMessages(page);
    return { messages: msgs.map((m, i) => ({ ...m, seq: page[i].seq })), has_more: rows.length > limit, next_before_seq: page.length ? page[0].seq : null };
  });

  // ---------- sending & streaming ----------
  function pipeRun(c, runId, after, sse, preface) {
    let sub = null; let closed = false;
    const finish = () => { if (closed) return; closed = true; sub?.unsubscribe(); sse.end(); };
    const onEvent = (ev) => { sse.send(ev); if (isTerminal(ev.type)) finish(); };
    if (preface) sse.send(preface);
    sub = runs.subscribe(runId, c.user.id, after, onEvent);
    if (closed) return;
    if (!sub.live) return finish();
    c.res.on('close', () => { closed = true; sub.unsubscribe(); });
  }
  const wantsSSE = (c) => String(c.req.headers.accept ?? '').includes('text/event-stream') || c.body?.stream === true;
  r.post('/v1/chats/:id/messages', (c) => {
    limiter.check(`send:${c.user.id}`, 60, 60_000);
    const chat = getChat(c.params.id, c.user); const b = c.body;
    const ids = b.attachment_ids ?? [];
    if (!Array.isArray(ids) || ids.length > 20) throw err(400, 'invalid_request', 'attachment_ids must be an array of at most 20 ids');
    const result = runs.sendMessage({ user: c.user, chat, text: b.text === undefined ? '' : str(b.text, 'text', 200000), attachmentIds: ids,
      clientId: b.client_message_id ? str(b.client_message_id, 'client_message_id', 100) : null, params: runParams(b) });
    if (!wantsSSE(c)) return new Reply(202, result);
    const sse = openSSE(c.res);
    if (!result.run) return sse.end();
    pipeRun(c, result.run.id, 0, sse, { seq: 0, type: 'message.created', data: result });
  });
  r.post('/v1/chats/:id/regenerate', (c) => {
    limiter.check(`send:${c.user.id}`, 60, 60_000);
    const chat = getChat(c.params.id, c.user);
    const result = runs.regenerate({ user: c.user, chat, params: runParams(c.body) });
    if (!wantsSSE(c)) return new Reply(202, result);
    pipeRun(c, result.run.id, 0, openSSE(c.res), { seq: 0, type: 'message.created', data: result });
  });
  r.get('/v1/runs/:id', (c) => runs.publicRun(runs.getRun(c.params.id, c.user.id)));
  r.get('/v1/runs/:id/events', (c) => {
    const after = int(c.query.after ?? c.req.headers['last-event-id'], 0, 0, 1e12);
    runs.getRun(c.params.id, c.user.id);
    pipeRun(c, c.params.id, after, openSSE(c.res));
  });
  r.post('/v1/runs/:id/cancel', (c) => { runs.cancel(c.params.id, c.user.id); return runs.publicRun(runs.getRun(c.params.id, c.user.id)); });
  r.post('/v1/runs/:id/approval', async (c) => {
    if (!c.body.request_id || !c.body.choice) throw err(400, 'invalid_request', 'request_id and choice are required');
    await runs.approve(c.params.id, c.user, c.body);
    return { ok: true };
  });

  r.get('/v1/search', (c) => {
    const q = String(c.query.q ?? '').trim();
    if (q.length < 2) throw err(400, 'invalid_request', 'q must be at least 2 characters');
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const chats = db.all("SELECT * FROM chats WHERE user_id = ? AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 20", c.user.id, like).map(chatPub);
    const messages = db.all(`SELECT m.id, m.chat_id, m.role, m.text, c.title FROM messages m JOIN chats c ON c.id = m.chat_id
      WHERE m.user_id = ? AND m.status != 'streaming' AND m.text LIKE ? ESCAPE '\\' ORDER BY m.seq DESC LIMIT 30`, c.user.id, like).map((m) => {
      const i = Math.max(0, m.text.toLowerCase().indexOf(q.toLowerCase()));
      return { message_id: m.id, chat_id: m.chat_id, chat_title: m.title, role: m.role, snippet: m.text.slice(Math.max(0, i - 60), i + q.length + 60) };
    });
    return { chats, messages };
  });

  // ---------- attachments ----------
  r.post('/v1/attachments', async (c) => {
    limiter.check(`upload:${c.user.id}`, 120, 60_000);
    const filename = c.query.filename ?? c.req.headers['x-filename'] ?? 'upload';
    const a = await media.save(c.req, c.user, { filename: decodeURIComponent(String(filename)), mime: c.req.headers['content-type'] });
    return created(media.publicAttachment(a));
  }, { raw: true });
  r.get('/v1/attachments/:id', (c) => media.publicAttachment(media.get(c.params.id, c.user.id)));
  r.put('/v1/attachments/:id/extracted', (c) => {
    const a = media.get(c.params.id, c.user.id);
    db.run('UPDATE attachments SET extracted_text = ? WHERE id = ?', str(c.body.text, 'text', 2_000_000), a.id);
    return media.publicAttachment(media.get(a.id, c.user.id));
  });
  r.delete('/v1/attachments/:id', (c) => {
    const a = media.get(c.params.id, c.user.id);
    media.removeFiles(a);
    db.run('DELETE FROM attachments WHERE id = ?', a.id);
  });
  const serveFile = (c, file, mime, filename) => {
    if (!file || !fs.existsSync(file)) throw err(404, 'not_found', 'File is no longer on disk');
    const size = fs.statSync(file).size;
    let start = 0; let end = size - 1; let status = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(c.req.headers.range ?? '');
    const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'private, max-age=3600' };
    if (m && (m[1] || m[2])) {
      if (m[1] === '') start = Math.max(0, size - Number(m[2])); else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (start > end || start >= size) { c.res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return c.res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    c.res.writeHead(status, headers);
    fs.createReadStream(file, { start, end }).pipe(c.res);
  };
  r.get('/v1/attachments/:id/content', (c) => { const a = media.get(c.params.id, c.user.id); serveFile(c, a.path, a.mime, a.filename); });
  r.get('/v1/attachments/:id/thumbnail', (c) => { const a = media.get(c.params.id, c.user.id); serveFile(c, a.thumb_path, 'image/jpeg', 'thumbnail.jpg'); });

  // ---------- models ----------
  r.get('/v1/models', () => ({
    models: registry.listPublicModels().map((m) => ({ id: m.id, name: m.display_name, tier: m.tier, capabilities: m.capabilities, status: m.status, server_name: m.server_name, loaded: m.loaded, context_length: m.context_length })),
    tiers: TIERS,
    picks: { fast: settings.get('model_fast') || null, smart: settings.get('model_smart') || null },
  }));

  // ---------- agents ----------
  r.get('/v1/agents', (c) => ({ agents: db.all('SELECT * FROM agents WHERE user_id = ? ORDER BY name', c.user.id).map(agentPub) }));
  r.post('/v1/agents', (c) => {
    const b = c.body;
    const name = str(b.name ?? '', 'name', 80).trim();
    if (!name) throw err(400, 'invalid_request', 'name is required');
    if (b.tier !== undefined && b.tier !== null && !TIERS.includes(b.tier)) throw err(400, 'invalid_request', `tier must be one of ${TIERS.join(', ')}`);
    const id = newId('agt');
    db.run('INSERT INTO agents(id, user_id, name, description, persona, tier, model_id, tools, hermes_profile, hermes_api_key_enc, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, c.user.id, name, b.description ?? null, b.persona ?? null, b.tier ?? null, b.model_id ?? null, JSON.stringify(b.tools ?? []),
      b.hermes_profile ? str(b.hermes_profile, 'hermes_profile', 80) : `${c.user.id.slice(-6)}--${slugify(name)}`,
      app.secrets.seal(b.hermes_api_key), 1, now(), now());
    return created(agentPub(db.get('SELECT * FROM agents WHERE id = ?', id)));
  });
  const getAgent = (id, user) => {
    const a = db.get('SELECT * FROM agents WHERE id = ?', id);
    if (!a || a.user_id !== user.id) throw err(404, 'not_found', 'Agent not found');
    return a;
  };
  r.get('/v1/agents/:id', (c) => agentPub(getAgent(c.params.id, c.user)));
  r.patch('/v1/agents/:id', (c) => {
    const a = getAgent(c.params.id, c.user); const b = c.body;
    if (b.tier && !TIERS.includes(b.tier)) throw err(400, 'invalid_request', `tier must be one of ${TIERS.join(', ')}`);
    db.run('UPDATE agents SET name=?, description=?, persona=?, tier=?, model_id=?, tools=?, hermes_profile=?, hermes_api_key_enc=?, enabled=?, updated_at=? WHERE id=?',
      'name' in b ? str(b.name, 'name', 80) : a.name, 'description' in b ? b.description : a.description, 'persona' in b ? b.persona : a.persona,
      'tier' in b ? b.tier : a.tier, 'model_id' in b ? b.model_id : a.model_id, 'tools' in b ? JSON.stringify(b.tools) : a.tools,
      'hermes_profile' in b ? str(b.hermes_profile, 'hermes_profile', 80) : a.hermes_profile,
      'hermes_api_key' in b ? app.secrets.seal(b.hermes_api_key) : a.hermes_api_key_enc, 'enabled' in b ? Boolean(b.enabled) : a.enabled, now(), a.id);
    return agentPub(db.get('SELECT * FROM agents WHERE id = ?', a.id));
  });
  r.delete('/v1/agents/:id', (c) => { const a = getAgent(c.params.id, c.user); db.run('DELETE FROM agents WHERE id = ?', a.id); });
  r.get('/v1/agents/:id/status', async (c) => hermes.status(getAgent(c.params.id, c.user)));

  // ---------- memory ----------
  r.get('/v1/memories', (c) => ({ memories: memory.list(c.user.id, { q: c.query.q, limit: int(c.query.limit, 100, 1, 500), offset: int(c.query.offset, 0, 0, 1e9) }) }));
  r.post('/v1/memories', async (c) => {
    const m = await memory.add(c.user.id, { text: str(c.body.text ?? '', 'text', 2000), source: 'manual' });
    if (!m) throw err(400, 'invalid_request', 'text is required');
    return created(m);
  });
  r.patch('/v1/memories/:id', async (c) => {
    const m = await memory.update(c.user.id, c.params.id, str(c.body.text ?? '', 'text', 2000));
    if (!m) throw err(404, 'not_found', 'Memory not found');
    return m;
  });
  r.delete('/v1/memories/:id', (c) => { if (!memory.remove(c.user.id, c.params.id)) throw err(404, 'not_found', 'Memory not found'); });
  r.delete('/v1/memories', (c) => {
    if (c.query.confirm !== 'true') throw err(400, 'confirmation_required', 'Pass ?confirm=true to delete all memories');
    return { deleted: memory.clear(c.user.id) };
  });
}
