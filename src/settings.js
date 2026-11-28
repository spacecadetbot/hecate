import { parseJson } from './util.js';

const SECRET_KEYS = new Set(['hermes_key_enc', 'search_key_enc']);
// Kept by the gateway itself, not editable through PATCH /v1/admin/settings.
const INTERNAL_KEYS = new Set(['search_usage']);

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
      // Set once the owner finishes (or skips) the in-app first-time setup.
      setup_done: false,
      hermes_url: '',
      hermes_mode: 'completions',
      hermes_key_enc: '',
      // Web search (Brave). Off until the owner adds a key and turns it on. One Brave request = one search, whatever the result count.
      search_enabled: false,
      search_key_enc: '',
      search_results: 5,          // results per search (1-20)
      search_max_per_reply: 3,    // most searches the model may run for one reply
      search_monthly_cap: 900,    // the gateway stops searching at this many per calendar month (0 = no cap)
      search_usage: { month: '', count: 0 },
      // Image generation (Draw Things on a Mac, HTTP API server). Off until the owner adds the address and turns it on.
      image_enabled: false,
      image_url: '',
      image_width: 1024,
      image_height: 1024,
      image_steps: 0,             // 0 = whatever Draw Things uses by default
      image_negative: '',
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
      if (INTERNAL_KEYS.has(k)) continue;
      if (SECRET_KEYS.has(k)) { out[k.replace(/_enc$/, '_set')] = Boolean(this.get(k)); continue; }
      out[k] = this.get(k);
    }
    return out;
  }
  editableKeys() { return Object.keys(this.defaults).filter((k) => !SECRET_KEYS.has(k) && !INTERNAL_KEYS.has(k)); }
}
