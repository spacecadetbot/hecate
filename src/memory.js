import { newId, now, iso, log } from './util.js';
import { embed, chatOnce } from './llm.js';

const toBlob = (f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength);
const fromBlob = (u8) => new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
function cosine(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
const tokens = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

export class Memory {
  constructor({ db, registry, settings, config }) { this.db = db; this.registry = registry; this.settings = settings; this.config = config; }

  pub(m) { return { id: m.id, text: m.text, source: m.source, chat_id: m.chat_id, created_at: iso(m.created_at), updated_at: iso(m.updated_at) }; }

  async #embed(texts) {
    if (!this.settings.get('memory_embeddings')) return null; // default: never touch a second model
    const t = this.registry.embeddingTarget();
    if (!t) return null;
    try { return { vecs: await embed({ baseUrl: t.baseUrl, headers: t.headers, model: t.model, input: texts }), model: t.model }; }
    catch (e) { log.warn('embedding failed, falling back to keyword memory:', e.message); return null; }
  }

  list(userId, { q, limit = 100, offset = 0 } = {}) {
    const rows = q
      ? this.db.all('SELECT * FROM memories WHERE user_id = ? AND text LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?', userId, `%${q}%`, limit, offset)
      : this.db.all('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?', userId, limit, offset);
    return rows.map((m) => this.pub(m));
  }
  async add(userId, { text, source = 'manual', chatId = null }) {
    text = String(text ?? '').trim();
    if (!text) return null;
    const dup = this.db.get('SELECT * FROM memories WHERE user_id = ? AND lower(text) = lower(?)', userId, text);
    if (dup) { this.db.run('UPDATE memories SET updated_at = ? WHERE id = ?', now(), dup.id); return this.pub(dup); }
    const e = await this.#embed([text]);
    if (e) {
      const near = this.db.all('SELECT * FROM memories WHERE user_id = ? AND embedding IS NOT NULL AND embedding_model = ?', userId, e.model)
        .find((m) => cosine(fromBlob(m.embedding), e.vecs[0]) > 0.93);
      if (near) { this.db.run('UPDATE memories SET updated_at = ? WHERE id = ?', now(), near.id); return this.pub(near); }
    }
    const id = newId('mem');
    this.db.run('INSERT INTO memories(id, user_id, text, source, chat_id, embedding, embedding_model, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, userId, text, source, chatId, e ? toBlob(e.vecs[0]) : null, e?.model ?? null, now(), now());
    return this.pub(this.db.get('SELECT * FROM memories WHERE id = ?', id));
  }
  async update(userId, id, text) {
    const m = this.db.get('SELECT * FROM memories WHERE id = ? AND user_id = ?', id, userId);
    if (!m) return null;
    const e = await this.#embed([text]);
    this.db.run('UPDATE memories SET text = ?, embedding = ?, embedding_model = ?, updated_at = ? WHERE id = ?', text, e ? toBlob(e.vecs[0]) : null, e?.model ?? null, now(), id);
    return this.pub(this.db.get('SELECT * FROM memories WHERE id = ?', id));
  }
  remove(userId, id) { return this.db.run('DELETE FROM memories WHERE id = ? AND user_id = ?', id, userId).changes > 0; }
  clear(userId) { return this.db.run('DELETE FROM memories WHERE user_id = ?', userId).changes; }

  /** Relevant memories for a prompt. Small stores are injected whole; larger ones are ranked. */
  async search(userId, query, k = 8) {
    const all = this.db.all('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC', userId);
    const cap = this.settings.get('memory_embeddings') ? 12 : 30;
    if (all.length <= cap) return all.map((m) => m.text);
    const e = await this.#embed([query]);
    const qt = tokens(query);
    const scored = all.map((m) => {
      if (e && m.embedding && m.embedding_model === e.model) return { m, s: cosine(fromBlob(m.embedding), e.vecs[0]), min: 0.3 };
      const mt = tokens(m.text);
      let hit = 0; for (const t of qt) if (mt.has(t)) hit++;
      return { m, s: qt.size ? (hit / qt.size) * 0.6 : 0, min: 0.1 };
    });
    const ranked = scored.filter((x) => x.s >= x.min).sort((a, b) => b.s - a.s).map((x) => x.m.text);
    const out = ranked.slice(0, k);
    for (const m of all.slice(0, 3)) if (out.length < k && !out.includes(m.text)) out.push(m.text); // always include the newest few
    return out;
  }

  /**
   * Background: ask the model that just answered (so nothing has to be swapped in) to keep the user's memory up to date:
   * add new lasting facts, correct ones that changed, and drop ones the user asked to forget or that are now wrong.
   * `transcript` is the last few exchanges as plain text; `cand` is the registry candidate that produced the reply.
   * Returns {added, updated, removed} (arrays of short texts) when something changed, else null.
   */
  async extractAfterTurn({ userId, chatId, cand, transcript }) {
    if (!this.settings.get('memory_extraction') || !transcript?.trim() || !cand) return null;
    try {
      const existing = this.db.all('SELECT id, text FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 60', userId);
      const known = existing.length ? existing.map((m, i) => `${i + 1}. ${m.text}`).join('\n') : '(nothing yet)';
      const out = await chatOnce({
        baseUrl: cand.server.base_url, headers: cand.server.headers,
        firstTokenTimeoutMs: 120000, idleTimeoutMs: 60000,
        body: {
          model: cand.model.upstream_id, temperature: 0.2,
          messages: [
            { role: 'system', content: [
              'You maintain long-term memory about the user for a personal assistant.',
              'Compare the conversation with what is already remembered and reply with ONLY a JSON object: {"add": [...], "update": [{"n": 3, "text": "..."}], "forget": [5]}.',
              '- add: up to 3 short, self-contained facts about the USER (preferences, ongoing projects, people, their setup, plans, how they like answers) that will still matter weeks from now.',
              '- update: use when a remembered fact changed or is now more accurate; "n" is its number in the list.',
              '- forget: numbers of remembered facts the user asked you to forget or that are now clearly wrong.',
              'If the user says "remember ..." save it; if they say "forget ...", forget it. Skip anything transient, speculative, or about the assistant. Never store passwords, API keys, or government/financial ID numbers.',
              'Use empty arrays when nothing should change.',
            ].join('\n') },
            { role: 'user', content: `Already remembered:\n${known}\n\nConversation:\n${transcript.slice(0, 8000)}` },
          ],
        },
      });
      const s0 = out.indexOf('{'), e0 = out.lastIndexOf('}');
      let plan = null;
      if (s0 !== -1 && e0 > s0) plan = JSON.parse(out.slice(s0, e0 + 1));
      else { // older style: a bare JSON array of facts
        const s1 = out.indexOf('['), e1 = out.lastIndexOf(']');
        if (s1 !== -1 && e1 > s1) plan = { add: JSON.parse(out.slice(s1, e1 + 1)) };
      }
      if (!plan) return null;
      const result = { added: [], updated: [], removed: [] };
      const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
      for (const f of strs(plan.add).slice(0, 3)) {
        const before = this.db.get('SELECT COUNT(*) AS c FROM memories WHERE user_id = ?', userId).c;
        const m = await this.add(userId, { text: f.slice(0, 500), source: 'auto', chatId });
        if (m && this.db.get('SELECT COUNT(*) AS c FROM memories WHERE user_id = ?', userId).c > before) result.added.push(m.text);
      }
      for (const u of (Array.isArray(plan.update) ? plan.update : []).slice(0, 3)) {
        const row = existing[Number(u?.n) - 1];
        if (row && typeof u.text === 'string' && u.text.trim() && u.text.trim() !== row.text) {
          const m = await this.update(userId, row.id, u.text.trim().slice(0, 500));
          if (m) result.updated.push(m.text);
        }
      }
      for (const n of (Array.isArray(plan.forget) ? plan.forget : []).slice(0, 3)) {
        const row = existing[Number(n) - 1];
        if (row && this.remove(userId, row.id)) result.removed.push(row.text);
      }
      return result.added.length || result.updated.length || result.removed.length ? result : null;
    } catch (e) { log.debug('memory extraction skipped:', e.message); return null; }
  }
}
