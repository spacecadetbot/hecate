import { parseJson } from './util.js';

const SECRET_KEYS = new Set(['hermes_key_enc']);

export class Settings {
  constructor(db, config) {
    this.db = db;
    this.defaults = {
      open_signup: config.openSignup,
      memory_extraction: true,
      title_generation: true,
      stt_url: '',
      stt_model: 'whisper-1',
      // The two models you picked (`hecate models`). When set, the gateway only uses these for normal chat; other models are
      // reachable only when a request names one explicitly. Empty = let the gateway choose by tier.
      model_fast: '',
      model_smart: '',
      embedding_model_id: '',
      // Memory works without an embedding model (recent + keyword match). Turn this on only if you want semantic search
      // and have room to keep the embedding model loaded.
      memory_embeddings: false,
      // Look for new memories after the first message of a chat, then every N user messages (uses the model that just answered).
      memory_extract_every: 4,
      // Title a chat after its first message and re-check every N user messages (only if you haven't renamed it).
      title_regen_every: 25,
      default_system_prompt: '',
      hermes_url: '',
      hermes_mode: 'completions',
      hermes_key_enc: '',
    };
  }
  get(key) {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? parseJson(row.value, this.defaults[key]) : this.defaults[key];
  }
  set(key, value) {
    if (!(key in this.defaults)) return false;
    this.db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    return true;
  }
  /** Settings safe to show to the admin (secrets masked). */
  all() {
    const out = {};
    for (const k of Object.keys(this.defaults)) {
      if (SECRET_KEYS.has(k)) { out[k.replace(/_enc$/, '_set')] = Boolean(this.get(k)); continue; }
      out[k] = this.get(k);
    }
    return out;
  }
  editableKeys() { return Object.keys(this.defaults).filter((k) => !SECRET_KEYS.has(k)); }
}
