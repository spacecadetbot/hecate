import { err, newId, now, iso, parseJson, log } from './util.js';

export const TIERS = ['fast', 'smart'];
export const CAPABILITIES = ['text', 'vision', 'audio', 'video', 'tools', 'reasoning', 'embedding'];

/** Best-effort guess of what a model can do. Admins can override per model. */
export function guessCapabilities(id, v0) {
  const n = id.toLowerCase();
  const c = v0?.capabilities; // LM Studio v1: object {vision, trained_for_tool_use, reasoning}; v0: array of strings
  const isObj = c && typeof c === 'object' && !Array.isArray(c);
  if (v0?.type === 'embedding' || v0?.type === 'embeddings' || /embed|(^|[\/\-_])bge[-_]|nomic-embed|(^|[\/\-_])e5[-_]|(^|[\/\-_])gte[-_]/.test(n)) return ['embedding'];
  const caps = new Set(['text']);
  if (v0?.type === 'vlm' || (isObj && c.vision) || /(^|[\/\-_ ])(vl|vision|llava|pixtral|paligemma|minicpm-v|internvl|smolvlm|mllama)/.test(n) || /gemma[-_ ]?(3|4)/.test(n)) caps.add('vision');
  if (/gemma[-_ ]?(3n|4)/.test(n) || /omni/.test(n)) { caps.add('vision'); caps.add('audio'); caps.add('video'); }
  if (c?.includes?.('tool_use') || (isObj && c.trained_for_tool_use)) caps.add('tools');
  if (isObj && c.reasoning) caps.add('reasoning');
  if (/gpt-oss|qwen3|deepseek-r1|(^|[\/\-_])r1([\/\-_]|$)|reason|think|qwq|magistral/.test(n)) caps.add('reasoning');
  return [...caps];
}

export class Registry {
  constructor({ db, config, secrets, settings }) {
    this.db = db; this.config = config; this.secrets = secrets; this.settings = settings;
    this.timer = null; this.checking = false; this.lastDiscover = new Map();
    this.lastActivity = 0; this.lastCheckAt = 0;
  }

  // ----- helpers -----
  static normalizeBaseUrl(u) {
    let s = String(u ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(s)) throw err(400, 'invalid_url', 'base_url must start with http:// or https://');
    s = s.replace(/\/v1$/, '');
    return s;
  }
  headersFor(server) {
    const key = this.secrets.unseal(server.api_key_enc);
    return key ? { Authorization: `Bearer ${key}` } : {};
  }
  publicServer(s) {
    const count = this.db.get('SELECT COUNT(*) AS c FROM models WHERE server_id = ? AND present = 1', s.id).c;
    return {
      id: s.id, name: s.name, base_url: s.base_url, default_tier: s.default_tier, enabled: Boolean(s.enabled),
      status: s.status, latency_ms: s.latency_ms, last_checked_at: iso(s.last_checked_at), last_ok_at: iso(s.last_ok_at),
      last_error: s.last_error, has_api_key: Boolean(s.api_key_enc), model_count: count,
    };
  }
  publicModel(m, server) {
    return {
      id: m.id, server_id: m.server_id, server_name: server?.name ?? m.server_name, upstream_id: m.upstream_id,
      display_name: m.display_name || m.upstream_id, tier: m.tier, capabilities: parseJson(m.capabilities, ['text']),
      options: parseJson(m.options, {}), enabled: Boolean(m.enabled), present: Boolean(m.present),
      status: server?.status ?? m.status,
      loaded: parseJson(m.info, {}).loaded ?? null,
      // context_length = the window actually in use (what LM Studio loaded it with), else the model's maximum.
      context_length: parseJson(m.info, {}).loaded_context_length ?? parseJson(m.info, {}).max_context_length ?? null,
      max_context_length: parseJson(m.info, {}).max_context_length ?? null,
    };
  }
  getServer(id) {
    const s = this.db.get('SELECT * FROM model_servers WHERE id = ?', id);
    if (!s) throw err(404, 'not_found', 'Model server not found');
    return s;
  }

  // ----- CRUD -----
  async addServer({ name, base_url, api_key, default_tier = 'fast' }) {
    if (!name) throw err(400, 'invalid_request', 'name is required');
    if (!TIERS.includes(default_tier)) throw err(400, 'invalid_request', `default_tier must be one of ${TIERS.join(', ')}`);
    const id = newId('srv');
    this.db.run('INSERT INTO model_servers(id, name, base_url, api_key_enc, default_tier, created_at) VALUES(?,?,?,?,?,?)',
      id, name, Registry.normalizeBaseUrl(base_url), this.secrets.seal(api_key), default_tier, now());
    let validation;
    try { validation = { ok: true, models: await this.discover(id) }; }
    catch (e) { validation = { ok: false, error: e.message }; this.#markDown(id, e.message); }
    return { server: this.publicServer(this.getServer(id)), validation };
  }
  async updateServer(id, patch) {
    const s = this.getServer(id);
    const name = patch.name ?? s.name;
    const base = patch.base_url ? Registry.normalizeBaseUrl(patch.base_url) : s.base_url;
    const tier = patch.default_tier ?? s.default_tier;
    if (!TIERS.includes(tier)) throw err(400, 'invalid_request', `default_tier must be one of ${TIERS.join(', ')}`);
    const keyEnc = 'api_key' in patch ? this.secrets.seal(patch.api_key) : s.api_key_enc;
    const enabled = 'enabled' in patch ? (patch.enabled ? 1 : 0) : s.enabled;
    this.db.run('UPDATE model_servers SET name=?, base_url=?, default_tier=?, api_key_enc=?, enabled=? WHERE id=?', name, base, tier, keyEnc, enabled, id);
    if (patch.base_url || 'api_key' in patch) await this.discover(id).catch((e) => this.#markDown(id, e.message));
    return this.publicServer(this.getServer(id));
  }
  removeServer(id) { this.getServer(id); this.db.run('DELETE FROM model_servers WHERE id = ?', id); }
  updateModel(id, patch) {
    const m = this.db.get('SELECT * FROM models WHERE id = ?', id);
    if (!m) throw err(404, 'not_found', 'Model not found');
    if (patch.tier && !TIERS.includes(patch.tier)) throw err(400, 'invalid_request', `tier must be one of ${TIERS.join(', ')}`);
    if (patch.capabilities && (!Array.isArray(patch.capabilities) || patch.capabilities.some((c) => !CAPABILITIES.includes(c)))) {
      throw err(400, 'invalid_request', `capabilities must be a subset of ${CAPABILITIES.join(', ')}`);
    }
    this.db.run('UPDATE models SET display_name=?, tier=?, capabilities=?, options=?, enabled=? WHERE id=?',
      patch.display_name ?? m.display_name, patch.tier ?? m.tier,
      patch.capabilities ? JSON.stringify(patch.capabilities) : m.capabilities,
      patch.options ? JSON.stringify(patch.options) : m.options,
      'enabled' in patch ? (patch.enabled ? 1 : 0) : m.enabled, id);
    return this.publicModel(this.db.get('SELECT * FROM models WHERE id = ?', id), this.getServer(m.server_id));
  }

  // ----- discovery & health -----
  async #fetchJson(server, path, timeoutMs) {
    const res = await fetch(server.base_url + path, { headers: this.headersFor(server), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return res.json();
  }
  /** Reads the server's model list and upserts it; keeps admin edits for existing models. */
  async discover(id) {
    const s = this.getServer(id);
    // LM Studio's native v1 list first (richer: type, capabilities, loaded state, context length), then OpenAI-style.
    let meta = {}; let ids = []; let kind = 'openai';
    try {
      const v1 = await this.#fetchJson(s, '/api/v1/models', 8000);
      const arr = Array.isArray(v1.models) ? v1.models : [];
      if (arr.length || Array.isArray(v1.models)) {
        kind = 'lmstudio';
        for (const m of arr) {
          if (!m.key || m.type === 'decision') continue;
          meta[m.key] = { ...m, id: m.key };
          ids.push(m.key);
        }
      }
    } catch { /* not LM Studio ≥0.4, or auth required: fall through */ }
    if (kind === 'openai') {
      let list;
      try { list = await this.#fetchJson(s, '/v1/models', 8000); }
      catch (e) { throw new Error(e.cause?.message ?? e.message); }
      ids = (list.data ?? []).map((m) => m.id).filter(Boolean);
      try { for (const m of (await this.#fetchJson(s, '/api/v0/models', 4000)).data ?? []) meta[m.id] = m; } catch { /* only LM Studio has this */ }
    }
    const infoOf = (m) => m ? JSON.stringify({
      loaded: Array.isArray(m.loaded_instances) ? m.loaded_instances.length > 0 : m.state === 'loaded',
      max_context_length: m.max_context_length ?? null,
      loaded_context_length: m.loaded_context_length ?? m.loaded_instances?.[0]?.config?.context_length ?? null, params: m.params_string ?? null,
      quantization: typeof m.quantization === 'object' ? m.quantization?.name ?? null : m.quantization ?? null, format: m.format ?? null,
    }) : '{}';
    this.db.tx(() => {
      this.db.run('UPDATE models SET present = 0 WHERE server_id = ?', id);
      this.db.run('UPDATE model_servers SET kind = ? WHERE id = ?', kind, id);
      for (const upstream of ids) {
        const existing = this.db.get('SELECT id FROM models WHERE server_id = ? AND upstream_id = ?', id, upstream);
        if (existing) {
          this.db.run('UPDATE models SET present = 1, info = ? WHERE id = ?', infoOf(meta[upstream]), existing.id);
          // Models found before their abilities were known (or before the guesses improved) pick up newly detected ones.
          // Only ever adds: an owner's own overrides are never taken away.
          const row = this.db.get('SELECT capabilities FROM models WHERE id = ?', existing.id);
          const have = parseJson(row?.capabilities, ['text']);
          const found = guessCapabilities(upstream, meta[upstream]).filter((k) => !have.includes(k) && ['vision', 'audio', 'video'].includes(k));
          if (found.length && !have.includes('embedding')) this.db.run('UPDATE models SET capabilities = ? WHERE id = ?', JSON.stringify([...have, ...found]), existing.id);
        }
        else this.db.run('INSERT INTO models(id, server_id, upstream_id, display_name, tier, capabilities, info, created_at) VALUES(?,?,?,?,?,?,?,?)',
          newId('mdl'), id, upstream, meta[upstream]?.display_name ?? upstream, s.default_tier, JSON.stringify(guessCapabilities(upstream, meta[upstream])), infoOf(meta[upstream]), now());
      }
    });
    this.lastDiscover.set(id, now());
    this.db.run(`UPDATE model_servers SET status='healthy', last_checked_at=?, last_ok_at=?, last_error=NULL WHERE id=?`, now(), now(), id);
    return this.db.all('SELECT * FROM models WHERE server_id = ? AND present = 1', id).map((m) => this.publicModel(m, s));
  }
  #markDown(id, message) {
    this.db.run(`UPDATE model_servers SET status='unhealthy', last_checked_at=?, last_error=? WHERE id=?`, now(), String(message).slice(0, 300), id);
  }
  async checkServer(s) {
    const t0 = now();
    try {
      await this.#fetchJson(s, '/v1/models', this.config.healthTimeoutMs);
      const latency = now() - t0;
      const wasHealthy = s.status === 'healthy';
      this.db.run(`UPDATE model_servers SET status='healthy', latency_ms=?, last_checked_at=?, last_ok_at=?, last_error=NULL WHERE id=?`, latency, now(), now(), s.id);
      if (!wasHealthy || now() - (this.lastDiscover.get(s.id) ?? 0) > 60_000) await this.discover(s.id);
    } catch (e) {
      if (s.status !== 'unhealthy') log.warn(`model server "${s.name}" is unreachable: ${e.cause?.message ?? e.message}`);
      this.#markDown(s.id, e.cause?.message ?? e.message);
    }
  }
  /** Called on every authenticated API request. Wakes the health checks, and refreshes stale status right away. */
  touch() {
    this.lastActivity = now();
    if (now() - this.lastCheckAt > this.config.healthIntervalMs) this.checkAll();
  }
  async checkAll() {
    if (this.checking) return;
    this.checking = true;
    this.lastCheckAt = now();
    try {
      const servers = this.db.all('SELECT * FROM model_servers WHERE enabled = 1');
      await Promise.allSettled(servers.map((s) => this.checkServer(s)));
    } finally { this.checking = false; }
  }
  start() {
    this.lastActivity = now();
    this.checkAll();
    this.timer = setInterval(() => {
      const window = this.config.healthActiveWindowMs;
      if (window > 0 && now() - this.lastActivity > window) return; // idle: stop polling the model servers
      this.checkAll();
    }, this.config.healthIntervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); }

  // ----- routing -----
  #candidateRows() {
    return this.db.all(`SELECT m.*, s.name AS server_name, s.base_url, s.api_key_enc, s.status, s.latency_ms
      FROM models m JOIN model_servers s ON s.id = m.server_id WHERE m.enabled = 1 AND m.present = 1 AND s.enabled = 1`);
  }
  /**
   * Orders usable chat models for one turn. Unhealthy servers go last (health can be stale).
   * needs: {vision, audio, video}. Explicit modelId goes first.
   */
  pick({ tier = 'fast', thinkHarder = false, needs = {}, modelId = null, exclude = [] } = {}) {
    const want = thinkHarder ? 'smart' : (TIERS.includes(tier) ? tier : 'fast');
    let rows = this.#candidateRows().map((r) => ({ ...r, caps: parseJson(r.capabilities, ['text']) }))
      .filter((r) => !r.caps.includes('embedding') && !exclude.includes(r.id));
    // Models the owner picked for each tier. If any usable pick exists, only the picks (plus an explicitly requested model) are candidates.
    const picks = { fast: this.settings.get('model_fast') || null, smart: this.settings.get('model_smart') || null };
    const pinnedIds = Object.values(picks).filter((id) => id && rows.some((r) => r.id === id));
    if (pinnedIds.length) rows = rows.filter((r) => pinnedIds.includes(r.id) || r.id === modelId);
    const scored = rows.map((r) => {
      let score = 0;
      if (picks[want] === r.id) score += 10000;      // the model picked for this tier
      else if (pinnedIds.includes(r.id)) score += 500; // the other pick is the next-best fallback
      if (r.tier === want) score += 100;
      // Automatic mode: a model LM Studio already has in memory beats one it would have to load (which can evict the loaded one).
      if (!picks[want] && parseJson(r.info, {}).loaded) score += 50;
      for (const k of ['vision', 'audio', 'video']) if (needs[k] && r.caps.includes(k)) score += 30;
      if (thinkHarder && r.caps.includes('reasoning')) score += 20;
      if (r.status === 'unhealthy') score -= 1000;
      if (r.status === 'unknown') score -= 5;
      score -= Math.min(10, (r.latency_ms ?? 0) / 500);
      return { r, score };
    }).sort((a, b) => b.score - a.score);
    let ordered = scored.map((x) => x.r);
    if (modelId) {
      const i = ordered.findIndex((r) => r.id === modelId);
      if (i > 0) ordered.unshift(...ordered.splice(i, 1));
    }
    return ordered.map((r) => ({
      model: { id: r.id, upstream_id: r.upstream_id, display_name: r.display_name || r.upstream_id, tier: r.tier, capabilities: r.caps, options: parseJson(r.options, {}) },
      server: { id: r.server_id, name: r.server_name, base_url: r.base_url, status: r.status, headers: this.headersFor({ api_key_enc: r.api_key_enc }) },
    }));
  }
  /** Resolves an OpenAI-style model name (alias, id or upstream name) for the /openai passthrough. */
  resolveName(name) {
    if (!name || name === 'hecate-fast' || name === 'fast') return { tier: 'fast' };
    if (name === 'hecate-smart' || name === 'smart') return { tier: 'smart' };
    const row = this.#candidateRows().find((r) => r.id === name || r.upstream_id === name);
    return row ? { modelId: row.id } : { tier: 'fast' };
  }
  embeddingTarget() {
    const chosen = this.settings.get('embedding_model_id');
    const rows = this.#candidateRows().map((r) => ({ ...r, caps: parseJson(r.capabilities, []) })).filter((r) => r.caps.includes('embedding') && r.status !== 'unhealthy');
    const r = rows.find((x) => x.id === chosen) ?? rows[0];
    return r ? { model: r.upstream_id, id: r.id, baseUrl: r.base_url, headers: this.headersFor({ api_key_enc: r.api_key_enc }) } : null;
  }
  listPublicModels() {
    return this.#candidateRows().map((m) => this.publicModel(m)).filter((m) => !m.capabilities.includes('embedding'));
  }
  listAdminModels() {
    return this.db.all(`SELECT m.*, s.name AS server_name, s.status FROM models m JOIN model_servers s ON s.id = m.server_id ORDER BY s.name, m.upstream_id`).map((m) => this.publicModel(m));
  }
}
