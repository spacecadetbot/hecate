import { SEARCH_GUIDE } from './search.js';
import { err, newId, now, iso, parseJson, log, truncate } from './util.js';
import { streamChat, chatOnce, UpstreamError, CancelledError } from './llm.js';

export const EVENT_TYPES = [
  'run.started', 'model.selected', 'model.fallback', 'attachment.processing', 'thinking.delta', 'thinking.done',
  'tool.started', 'tool.progress', 'tool.completed', 'tool.failed', 'assistant.commentary', 'assistant.delta',
  'approval.request', 'approval.resolved', 'message.completed', 'run.completed', 'run.failed', 'run.cancelled',
];
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);
export const isTerminal = (t) => TERMINAL.has(t);

class RunError extends Error { constructor(code, message) { super(message); this.code = code; } }

const DEFAULT_SYSTEM = "You are Hecate, a helpful, honest assistant that runs on the user's own hardware. Be clear and direct.";

export const DISCLAIMER = "Keep in mind, I'm a local assistant powered by AI and may make mistakes. Always verify important details.";

export class RunManager {
  constructor({ db, config, registry, media, memory, settings, hermes, search }) {
    Object.assign(this, { db, config, registry, media, memory, settings, hermes, search });
    this.active = new Map();
    this.post = new Map(); // run id -> promise of background work (memory learning) that follows a finished run
  }

  // ---------- serialization ----------
  publicMessages(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const atts = this.db.all(`SELECT * FROM attachments WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, ...ids);
    const by = new Map();
    for (const a of atts) { if (!by.has(a.message_id)) by.set(a.message_id, []); by.get(a.message_id).push(this.media.publicAttachment(a)); }
    const wants = new Map();
    for (const m of rows) {
      if (m.role !== 'assistant' || m.status !== 'complete' || wants.has(m.chat_id)) continue;
      const u = this.db.get('SELECT u.show_disclaimer AS s FROM chats c JOIN users u ON u.id = c.user_id WHERE c.id = ?', m.chat_id);
      wants.set(m.chat_id, !!u && u.s !== 0);
    }
    return rows.map((m) => ({
      disclaimer: m.role === 'assistant' && m.status === 'complete' && wants.get(m.chat_id) ? DISCLAIMER : null,
      id: m.id, chat_id: m.chat_id, role: m.role, text: m.text, reasoning: m.reasoning, thinking_ms: m.thinking_ms,
      status: m.status, model: m.model, usage: parseJson(m.usage), error: parseJson(m.error), run_id: m.run_id,
      attachments: by.get(m.id) ?? [], created_at: iso(m.created_at),
    }));
  }
  publicMessage(id) { return this.publicMessages([this.db.get('SELECT * FROM messages WHERE id = ?', id)])[0]; }
  publicRun(r) {
    const last = this.db.get('SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?', r.id)?.s ?? 0;
    return { id: r.id, chat_id: r.chat_id, message_id: r.message_id, user_message_id: r.user_message_id, status: r.status, model_id: r.model_id,
      error: parseJson(r.error), created_at: iso(r.created_at), finished_at: iso(r.finished_at), last_seq: last };
  }
  activeRunForChat(chatId) {
    for (const e of this.active.values()) if (e.run.chat_id === chatId) return e.run.id;
    return null;
  }

  // ---------- lifecycle at boot ----------
  recoverOrphans() {
    for (const r of this.db.all("SELECT * FROM runs WHERE status = 'running'")) {
      const seq = (this.db.get('SELECT MAX(seq) AS s FROM run_events WHERE run_id = ?', r.id)?.s ?? 0) + 1;
      const error = { code: 'gateway_restarted', message: 'The gateway restarted while this response was being generated.' };
      this.db.run('INSERT INTO run_events(run_id, seq, type, data, created_at) VALUES(?,?,?,?,?)', r.id, seq, 'run.failed', JSON.stringify({ run_id: r.id, error }), now());
      this.db.run("UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", JSON.stringify(error), now(), r.id);
      this.db.run("UPDATE messages SET status = 'failed', error = ? WHERE id = ? AND status = 'streaming'", JSON.stringify(error), r.message_id);
      log.warn(`marked orphaned run ${r.id} as failed`);
    }
  }
  pruneEvents() {
    this.db.run('DELETE FROM run_events WHERE created_at < ?', now() - this.config.eventRetentionDays * 86400_000);
  }

  // ---------- starting runs ----------
  sendMessage({ user, chat, text, attachmentIds = [], clientId, params = {} }) {
    text = String(text ?? '').trim();
    if (!text && !attachmentIds.length) throw err(400, 'invalid_request', 'Send some text or at least one attachment');
    if (clientId) {
      const prev = this.db.get('SELECT * FROM messages WHERE chat_id = ? AND client_id = ?', chat.id, clientId);
      if (prev) {
        const run = this.db.get('SELECT * FROM runs WHERE user_message_id = ? ORDER BY created_at DESC', prev.id);
        return { user_message: this.publicMessage(prev.id), assistant_message: run ? this.publicMessage(run.message_id) : null, run: run ? this.publicRun(run) : null, deduplicated: true };
      }
    }
    if (this.activeRunForChat(chat.id)) throw err(409, 'run_in_progress', 'This chat is still generating a response. Cancel it or wait for it to finish.');
    this.#checkCapacity(user);
    const atts = attachmentIds.map((id) => {
      const a = this.db.get('SELECT * FROM attachments WHERE id = ?', id);
      if (!a || a.user_id !== user.id) throw err(404, 'not_found', `Attachment ${id} not found`);
      if (a.message_id) throw err(400, 'attachment_in_use', `Attachment ${id} is already used by another message`);
      return a;
    });
    const userMsgId = newId('msg');
    this.db.tx(() => {
      this.db.run('INSERT INTO messages(id, chat_id, user_id, role, text, status, client_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        userMsgId, chat.id, user.id, 'user', text, 'complete', clientId ?? null, now(), now());
      for (const a of atts) this.db.run('UPDATE attachments SET message_id = ? WHERE id = ?', userMsgId, a.id);
      if (chat.title === 'New chat') {
        const t = truncate((text || atts[0]?.filename || 'New chat').replace(/\s+/g, ' ').trim(), 48);
        this.db.run('UPDATE chats SET title = ? WHERE id = ?', t, chat.id);
      }
    });
    return this.#start({ user, chat: this.db.get('SELECT * FROM chats WHERE id = ?', chat.id), userMessageId: userMsgId, params });
  }
  regenerate({ user, chat, params = {}, editText = null }) {
    if (this.activeRunForChat(chat.id)) throw err(409, 'run_in_progress', 'This chat is still generating a response.');
    this.#checkCapacity(user);
    const last = this.db.get('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1', chat.id);
    if (!last) throw err(400, 'nothing_to_regenerate', 'This chat has no messages');
    if (last.role === 'assistant') this.db.run('DELETE FROM messages WHERE id = ?', last.id);
    const userMsg = this.db.get("SELECT * FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1", chat.id);
    if (!userMsg) throw err(400, 'nothing_to_regenerate', 'This chat has no user message');
    // Editing: the last user message is rewritten and the reply is generated again from it.
    if (typeof editText === 'string' && editText.trim()) this.db.run('UPDATE messages SET text = ?, updated_at = ? WHERE id = ?', editText, now(), userMsg.id);
    return this.#start({ user, chat, userMessageId: userMsg.id, params });
  }
  #checkCapacity(user) {
    const mine = [...this.active.values()].filter((e) => e.user.id === user.id).length;
    if (mine >= this.config.maxConcurrentRunsPerUser) throw err(429, 'too_many_runs', 'Too many responses are generating at once');
  }
  #start({ user, chat, userMessageId, params }) {
    const runId = newId('run'); const asstId = newId('msg');
    this.db.tx(() => {
      this.db.run('INSERT INTO messages(id, chat_id, user_id, role, text, status, run_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        asstId, chat.id, user.id, 'assistant', '', 'streaming', runId, now(), now());
      this.db.run('INSERT INTO runs(id, user_id, chat_id, message_id, user_message_id, status, params, created_at) VALUES(?,?,?,?,?,?,?,?)',
        runId, user.id, chat.id, asstId, userMessageId, 'running', JSON.stringify(params), now());
      this.db.run('UPDATE chats SET updated_at = ? WHERE id = ?', now(), chat.id);
    });
    const run = this.db.get('SELECT * FROM runs WHERE id = ?', runId);
    const entry = {
      run, user, chat, params, seq: 0, listeners: new Set(), abort: new AbortController(), cancelHooks: [],
      text: '', reasoning: '', usage: null, modelName: null, modelId: null, hermesRunId: null,
      pend: { thinking: '', assistant: '' }, flushTimer: null, thinkOpen: false, thinkStartedAt: 0, thinkMs: 0,
      persistTimer: null, done: false,
    };
    entry.persistTimer = setInterval(() => {
      this.db.run('UPDATE messages SET text = ?, reasoning = ?, updated_at = ? WHERE id = ?', entry.text, entry.reasoning || null, now(), run.message_id);
    }, 1000);
    entry.persistTimer.unref?.();
    this.active.set(runId, entry);
    this.#execute(entry).catch((e) => log.error('run executor crashed', e));
    return { user_message: this.publicMessage(userMessageId), assistant_message: this.publicMessage(asstId), run: this.publicRun(run) };
  }

  // ---------- events ----------
  #emit(entry, type, data = {}) {
    const seq = ++entry.seq;
    const full = { run_id: entry.run.id, seq, ...data };
    this.db.run('INSERT INTO run_events(run_id, seq, type, data, created_at) VALUES(?,?,?,?,?)', entry.run.id, seq, type, JSON.stringify(full), now());
    const ev = { seq, type, data: full };
    for (const l of entry.listeners) { try { l(ev); } catch { /* a dead client must not break the run */ } }
    return ev;
  }
  /** Replays stored events after `after`, then streams live ones. Returns {live, unsubscribe}. */
  subscribe(runId, userId, after, listener) {
    const run = this.db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!run || run.user_id !== userId) throw err(404, 'not_found', 'Run not found');
    for (const r of this.db.all('SELECT seq, type, data FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq', runId, after)) {
      listener({ seq: r.seq, type: r.type, data: { seq: r.seq, ...parseJson(r.data, {}) } });
    }
    const entry = this.active.get(runId);
    if (!entry) return { live: false, unsubscribe() {} };
    entry.listeners.add(listener);
    return { live: true, unsubscribe: () => entry.listeners.delete(listener) };
  }
  getRun(runId, userId) {
    const r = this.db.get('SELECT * FROM runs WHERE id = ?', runId);
    if (!r || r.user_id !== userId) throw err(404, 'not_found', 'Run not found');
    return r;
  }
  cancel(runId, userId) {
    const run = this.getRun(runId, userId);
    const entry = this.active.get(runId);
    if (entry) {
      entry.abort.abort();
      for (const h of entry.cancelHooks) Promise.resolve().then(h).catch(() => {});
    }
    return run;
  }
  cancelChat(chatId) { for (const e of this.active.values()) if (e.run.chat_id === chatId) e.abort.abort(); }
  cancelUser(userId) { for (const e of this.active.values()) if (e.user.id === userId) e.abort.abort(); }

  // ---------- delta plumbing ----------
  #queue(entry, kind, text) {
    if (!text) return;
    if (kind === 'thinking') {
      entry.reasoning += text;
      if (!entry.thinkOpen) { entry.thinkOpen = true; entry.thinkStartedAt = now(); }
    } else {
      if (entry.thinkOpen) { this.#flush(entry); this.#closeThinking(entry); }
      entry.text += text;
    }
    entry.pend[kind] += text;
    if (!entry.flushTimer) entry.flushTimer = setTimeout(() => { entry.flushTimer = null; this.#flush(entry); }, 40);
  }
  #flush(entry) {
    if (entry.flushTimer) { clearTimeout(entry.flushTimer); entry.flushTimer = null; }
    if (entry.pend.thinking) { this.#emit(entry, 'thinking.delta', { delta: entry.pend.thinking }); entry.pend.thinking = ''; }
    if (entry.pend.assistant) { this.#emit(entry, 'assistant.delta', { delta: entry.pend.assistant }); entry.pend.assistant = ''; }
  }
  #closeThinking(entry) {
    entry.thinkOpen = false;
    const ms = now() - entry.thinkStartedAt;
    entry.thinkMs += ms;
    this.#emit(entry, 'thinking.done', { duration_ms: ms });
  }
  #finalize(entry, status, error) {
    if (entry.done) return;
    entry.done = true;
    clearInterval(entry.persistTimer);
    this.#flush(entry);
    if (entry.thinkOpen) this.#closeThinking(entry);
    const { run } = entry;
    const msgStatus = { completed: 'complete', failed: 'failed', cancelled: 'cancelled' }[status];
    this.db.run('UPDATE messages SET text=?, reasoning=?, status=?, model=?, usage=?, error=?, thinking_ms=?, updated_at=? WHERE id=?',
      entry.text, entry.reasoning || null, msgStatus, entry.modelName,
      (entry.usage || entry.finish || entry.searches) ? JSON.stringify({ ...(entry.usage ?? {}), ...(entry.finish ? { finish_reason: entry.finish } : {}), ...(entry.searches ? { searches: entry.searches } : {}) }) : null,
      error ? JSON.stringify(error) : null, entry.thinkMs || null, now(), run.message_id);
    this.db.run('UPDATE runs SET status=?, model_id=?, error=?, finished_at=?, hermes_run_id=? WHERE id=?',
      status, entry.modelId, error ? JSON.stringify(error) : null, now(), entry.hermesRunId, run.id);
    this.db.run('UPDATE chats SET updated_at = ? WHERE id = ?', now(), run.chat_id);
    if (entry.finish && entry.finish !== 'stop') log.warn(`run ${run.id} ended with finish_reason=${entry.finish} after ${entry.text.length} chars (${entry.modelName ?? 'unknown model'})`);
    const message = this.publicMessage(run.message_id);
    if (status === 'completed') { this.#emit(entry, 'message.completed', { message }); this.#emit(entry, 'run.completed', { status, message_id: run.message_id }); }
    else if (status === 'failed') this.#emit(entry, 'run.failed', { error, message });
    else this.#emit(entry, 'run.cancelled', { message });
    this.active.delete(run.id);
    entry.listeners.clear();
    if (status === 'completed') {
      const p = new Promise((res) => setImmediate(res)).then(() => this.#postTurn(entry)).catch((e) => { log.debug('post-turn work failed:', e.message); return {}; });
      this.post.set(run.id, p);
      p.finally(() => setTimeout(() => this.post.delete(run.id), 120_000).unref());
    }
  }

  async #execute(entry) {
    const { run, chat } = entry;
    this.#emit(entry, 'run.started', { chat_id: chat.id, message_id: run.message_id, user_message_id: run.user_message_id });
    try {
      if (chat.agent_id) await this.#runAgent(entry); else await this.#runChat(entry);
      this.#finalize(entry, 'completed');
    } catch (e) {
      if (e.cancelled || entry.abort.signal.aborted) return this.#finalize(entry, 'cancelled');
      let error;
      if (e instanceof UpstreamError) error = { code: e.network ? 'model_unreachable' : 'model_error', message: e.network ? `Could not reach the model server (${e.body})` : `The model server returned an error: ${truncate(e.body || e.message, 300)}` };
      else if (e.code && e.message) error = { code: e.code, message: e.message };
      else { log.error('run failed', e); error = { code: 'internal_error', message: 'Unexpected gateway error' }; }
      this.#finalize(entry, 'failed', error);
    }
  }

  // ---------- building the prompt ----------
  async #buildMessages(entry, userMsg, preparedParts) {
    const { chat, user } = entry;
    const agent = chat.agent_id ? this.db.get('SELECT * FROM agents WHERE id = ?', chat.agent_id) : null;
    let system = chat.system_prompt || agent?.persona || this.settings.get('default_system_prompt') || DEFAULT_SYSTEM;
    system += `\nCurrent date: ${new Date().toDateString()}.`;
    if (chat.use_memory) {
      // The profile: the account's name (from Apple sign-in) plus whatever has been learned about the person.
      if (user.display_name) system += `\n\nThe user's name is ${user.display_name}.`;
      const mem = await this.memory.search(user.id, userMsg.text, 8);
      if (mem.length) system += `\n\nWhat you know about the user (long-term memory; use it naturally, never recite it as a list):\n${mem.map((m) => `- ${m}`).join('\n')}`;
    }
    const rows = this.db.all("SELECT * FROM messages WHERE chat_id = ? AND seq < ? AND role IN ('user','assistant') AND status = 'complete' ORDER BY seq DESC LIMIT 200", chat.id, userMsg.seq);
    const ids = rows.map((r) => r.id);
    const hist = ids.length ? this.db.all(`SELECT * FROM attachments WHERE message_id IN (${ids.map(() => '?').join(',')})`, ...ids) : [];
    const items = []; let used = 0;
    for (const r of rows) {
      let content = r.text;
      for (const a of hist.filter((h) => h.message_id === r.id)) content += `\n\n${this.media.historyText(a)}`;
      if (!content.trim()) continue;
      used += content.length;
      if (used > this.config.contextChars && items.length) break;
      items.push({ role: r.role, content });
    }
    items.reverse();
    const merged = []; // some chat templates demand strict user/assistant alternation
    for (const m of items) {
      const prev = merged[merged.length - 1];
      if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`; else merged.push({ ...m });
    }
    while (merged.length && merged[0].role === 'assistant') merged.shift();
    const content = [];
    if (userMsg.text) content.push({ type: 'text', text: userMsg.text });
    content.push(...preparedParts);
    const current = { role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content };
    if (merged.length && merged[merged.length - 1].role === 'user') {
      // previous turn never got an answer (failed/cancelled): fold it into the current message
      const last = merged.pop();
      if (typeof current.content === 'string') current.content = `${last.content}\n\n${current.content}`;
      else current.content.unshift({ type: 'text', text: last.content });
    }
    return [{ role: 'system', content: system }, ...merged, current];
  }
  #statusReporter(entry) {
    return (a, status, detail) => this.#emit(entry, 'attachment.processing', { attachment_id: a.id, filename: a.filename, kind: a.kind, status, detail });
  }

  // ---------- normal chat ----------
  async #runChat(entry) {
    const { run, chat, params } = entry;
    const userMsg = this.db.get('SELECT * FROM messages WHERE id = ?', run.user_message_id);
    const atts = this.db.all('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', userMsg.id);
    const needs = { vision: atts.some((a) => a.kind === 'image'), audio: atts.some((a) => a.kind === 'audio'), video: atts.some((a) => a.kind === 'video') };
    const prefs = parseJson(chat.model_prefs, {});
    const cands = this.registry.pick({ tier: params.tier ?? prefs.tier ?? 'fast', thinkHarder: Boolean(params.think_harder), needs, modelId: params.model_id ?? prefs.model_id });
    if (!cands.length) throw new RunError('no_models', 'No model server is available. Add one in the admin settings and make sure it is running.');
    let lastErr = null;
    for (let i = 0; i < Math.min(cands.length, 3); i++) {
      const c = cands[i];
      if (i > 0) this.#emit(entry, 'model.fallback', { to: c.model.display_name, reason: truncate(lastErr?.message ?? 'previous model failed', 600) });
      log.info(`run ${run.id}: sending to ${c.model.upstream_id} on ${c.server.name} (tier ${c.model.tier}${i > 0 ? `, fallback #${i}` : ''})`);
      this.#emit(entry, 'model.selected', { model_id: c.model.id, name: c.model.display_name, server: c.server.name, tier: c.model.tier });
      let forceFallback = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        let native = false;
        try {
          const parts = [];
          for (const a of atts) {
            const r = await this.media.prepare(a, c.model, { status: this.#statusReporter(entry), signal: entry.abort.signal, forceFallback });
            parts.push(...r.parts); native ||= r.native;
          }
          const messages = await this.#buildMessages(entry, userMsg, parts);
          const body = { model: c.model.upstream_id, messages };
          if (params.think_harder && c.model.capabilities.includes('reasoning')) body.reasoning_effort = 'high';
          entry.modelName = c.model.display_name; entry.modelId = c.model.id; entry.used = c;
          // Web search: offered to models that can call tools, when the owner turned it on and added a key.
          const canSearch = params.search !== false && this.search.available && c.model.capabilities.includes('tools');
          let searchesLeft = canSearch ? Math.max(1, Number(this.settings.get('search_max_per_reply')) || 3) : 0;
          if (canSearch) { body.tools = [this.search.tool()]; messages[0].content += SEARCH_GUIDE; }
          for (let round = 0; round < 12; round++) {
            let roundText = ''; let calls = null;
            for await (const p of streamChat({ baseUrl: c.server.base_url, headers: c.server.headers, body, signal: entry.abort.signal,
              firstTokenTimeoutMs: this.config.firstTokenTimeoutMs, idleTimeoutMs: this.config.idleTimeoutMs })) {
              if (p.type === 'reasoning') this.#queue(entry, 'thinking', p.text);
              else if (p.type === 'content') { roundText += p.text; this.#queue(entry, 'assistant', p.text); }
              else if (p.type === 'usage') entry.usage = p.usage;
              else if (p.type === 'finish') entry.finish = p.reason;
              else if (p.type === 'tool_calls') calls = p.calls;
            }
            if (!calls || !body.tools) break;
            messages.push({ role: 'assistant', content: roundText, tool_calls: calls.map((t, i) => ({ id: t.id || `call_${round}_${i}`, type: 'function', function: { name: t.name, arguments: t.arguments || '{}' } })) });
            for (const [i, t] of calls.entries()) {
              const id = t.id || `call_${round}_${i}`;
              let content;
              if (t.name !== 'web_search') content = `Unknown tool "${t.name}".`;
              else if (searchesLeft <= 0 || !this.search.available) content = 'The search limit for this reply has been reached. Answer with what you already have.';
              else {
                let q = ''; try { q = String(JSON.parse(t.arguments || '{}').query ?? ''); } catch { /* bad arguments */ }
                searchesLeft--;
                this.#emit(entry, 'tool.started', { tool_name: 'web_search', preview: q });
                try {
                  const r = await this.search.query(q, { signal: entry.abort.signal });
                  content = r.text;
                  (entry.searches ??= []).push(q);
                  this.#emit(entry, 'tool.completed', { tool_name: 'web_search', preview: q });
                } catch (e) {
                  if (entry.abort.signal.aborted) throw e;
                  content = `The search failed: ${e.message}. Answer without it and tell the user the search did not work.`;
                  this.#emit(entry, 'tool.failed', { tool_name: 'web_search', preview: e.message });
                }
              }
              messages.push({ role: 'tool', tool_call_id: id, content });
            }
            if (searchesLeft <= 0) delete body.tools;   // out of searches: the next round has to answer
          }
          if (!entry.text && !entry.reasoning) throw new UpstreamError(502, 'the model returned an empty response');
          return;
        } catch (e) {
          if (e.cancelled || entry.abort.signal.aborted) throw e;
          if (entry.text || entry.reasoning) throw e; // output already reached the client; cannot silently retry
          lastErr = e;
          if (native && attempt === 0 && e instanceof UpstreamError && e.status >= 400 && e.status < 500) {
            forceFallback = true;
            this.#emit(entry, 'attachment.processing', { status: 'fallback', detail: 'Model rejected native media; retrying with extracted frames/transcript' });
            continue;
          }
          break;
        }
      }
    }
    throw lastErr ?? new RunError('no_models', 'No model could handle this request');
  }

  // ---------- agent chat (Hermes) ----------
  async #runAgent(entry) {
    const { run, chat } = entry;
    const agent = this.db.get('SELECT * FROM agents WHERE id = ?', chat.agent_id);
    if (!agent || !agent.enabled) throw new RunError('agent_unavailable', 'This agent no longer exists or is disabled.');
    const userMsg = this.db.get('SELECT * FROM messages WHERE id = ?', run.user_message_id);
    const atts = this.db.all('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', userMsg.id);
    const parts = [];
    for (const a of atts) {
      const r = await this.media.prepare(a, { capabilities: ['vision'], options: {} }, { status: this.#statusReporter(entry), signal: entry.abort.signal, forceFallback: true });
      parts.push(...r.parts);
    }
    const messages = await this.#buildMessages(entry, userMsg, parts);
    const text = [userMsg.text, ...parts.filter((p) => p.type === 'text').map((p) => p.text)].filter(Boolean).join('\n\n');
    entry.modelName = `agent: ${agent.name}`;
    this.#emit(entry, 'model.selected', { name: agent.name, server: 'hermes', tier: 'agent' });
    entry.cancelHooks.push(() => entry.hermesRunId && this.hermes.stop(agent, entry.hermesRunId));
    let final = null;
    for await (const ev of this.hermes.stream({ agent, chat, messages, text, signal: entry.abort.signal,
      firstTokenTimeoutMs: this.config.firstTokenTimeoutMs, idleTimeoutMs: this.config.idleTimeoutMs })) {
      switch (ev.type) {
        case 'reasoning': this.#queue(entry, 'thinking', ev.text); break;
        case 'content': this.#queue(entry, 'assistant', ev.text); break;
        case 'usage': entry.usage = ev.usage; break;
        case 'hermes_run': entry.hermesRunId = ev.id; break;
        case 'final': final = ev; if (ev.usage) entry.usage = ev.usage; break;
        case 'event': this.#flush(entry); this.#emit(entry, ev.name, ev.data); break;
        case 'approval': this.#flush(entry); this.#emit(entry, 'approval.request', ev.data); break;
        case 'failed': throw new RunError('agent_failed', String(ev.error));
        case 'cancelled': throw new CancelledError();
        default: break;
      }
    }
    if (!entry.text && final?.content) this.#queue(entry, 'assistant', final.content);
    if (!entry.text && !entry.reasoning) throw new RunError('agent_failed', 'The agent returned no response');
  }
  async approve(runId, user, body) {
    const run = this.getRun(runId, user.id);
    const entry = this.active.get(runId);
    const hid = entry?.hermesRunId ?? run.hermes_run_id;
    const chat = this.db.get('SELECT * FROM chats WHERE id = ?', run.chat_id);
    if (!chat?.agent_id || !hid) throw err(409, 'no_pending_approval', 'This run is not waiting for an approval');
    const agent = this.db.get('SELECT * FROM agents WHERE id = ?', chat.agent_id);
    await this.hermes.approve(agent, hid, body);
    if (entry) this.#emit(entry, 'approval.resolved', { request_id: body.request_id, choice: body.choice });
  }

  // ---------- background work after a successful turn ----------
  // Everything here runs on the SAME model that just answered, so LM Studio never has to swap models,
  // and only every few turns (see settings: memory_extract_every, title_regen_every).
  #recentExchange(chatId, exchanges) {
    const rows = this.db.all("SELECT role, text FROM messages WHERE chat_id = ? AND status = 'complete' AND text != '' ORDER BY created_at DESC, rowid DESC LIMIT ?", chatId, exchanges * 2).reverse();
    return rows.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, m.role === 'user' ? 1500 : 800)}`).join('\n\n');
  }
  async #postTurn(entry) {
    const { chat, user } = entry;
    const out = {};
    if (!entry.text || chat.agent_id || !entry.used) return out;
    const turns = this.db.get('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ? AND role = ?', chat.id, 'user').c;
    const every = (key, fallback) => Math.max(1, Number(this.settings.get(key)) || fallback);
    const memEvery = every('memory_extract_every', 4);
    // Learn every few messages, and right away when the person says to remember or forget something.
    const lastUser = this.db.get("SELECT text FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1", chat.id)?.text ?? '';
    const asked = /\b(remember|forget|don'?t forget|keep in mind|from now on|call me|my name is|note that)\b/i.test(lastUser);
    if (chat.use_memory && (asked || (turns - 1) % memEvery === 0)) {
      const memory = await this.memory.extractAfterTurn({ userId: user.id, chatId: chat.id, cand: entry.used, transcript: this.#recentExchange(chat.id, asked ? 1 : Math.min(turns, memEvery)) });
      if (memory) out.memory = memory;
    }
    const titleEvery = every('title_regen_every', 25);
    if (this.settings.get('title_generation') && (turns === 1 || turns % titleEvery === 0)) await this.#generateTitle(chat.id, entry, turns);
    return out;
  }
  async #generateTitle(chatId, entry, turns) {
    const chat = this.db.get('SELECT * FROM chats WHERE id = ?', chatId);
    if (!chat) return;
    const first = this.db.get('SELECT text FROM messages WHERE chat_id = ? AND role = ? ORDER BY created_at, rowid LIMIT 1', chatId, 'user');
    const provisional = truncate((first?.text || '').replace(/\s+/g, ' ').trim(), 48);
    // Only touch titles we own: the placeholder from the first message, or the last one we generated (not one the user renamed).
    const editable = turns === 1 ? chat.title === provisional : Boolean(chat.auto_title) && chat.title === chat.auto_title;
    if (!editable) return;
    const c = entry.used;
    const out = await chatOnce({ baseUrl: c.server.base_url, headers: c.server.headers, firstTokenTimeoutMs: 60000, idleTimeoutMs: 30000,
      body: { model: c.model.upstream_id, temperature: 0.3, messages: [
        { role: 'system', content: 'Write a title of 2 to 5 words for this conversation. Reply with the title only: no quotes, no trailing punctuation.' },
        { role: 'user', content: this.#recentExchange(chatId, 3) }] } });
    const title = truncate(out.split('\n')[0].replace(/^["'“”\s]+|["'“”.\s]+$/g, ''), 60);
    if (title && this.db.get('SELECT title FROM chats WHERE id = ?', chatId)?.title === chat.title) {
      this.db.run('UPDATE chats SET title = ?, auto_title = ? WHERE id = ?', title, title, chatId);
    }
  }
}
