import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const err = (status, code, message, extra) => new HttpError(status, code, message, extra);

export const now = () => Date.now();
/** ISO-8601 with whole seconds, so Swift's default .iso8601 decoder accepts it. */
export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36).padStart(9, '0')}${crypto.randomBytes(7).toString('hex')}`;
}
export const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');
export const randomToken = (prefix, bytes = 32) => `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
export const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function parseJson(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
export function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let level = LEVELS.info;
export const setLogLevel = (l) => { level = LEVELS[l] ?? LEVELS.info; };
export const log = Object.fromEntries(Object.keys(LEVELS).map((k) => [k, (...a) => {
  if (LEVELS[k] >= level) (k === 'debug' ? console.log : console[k])(new Date().toISOString(), k.toUpperCase(), ...a);
}]));

/** Encrypts small secrets (model-server keys) at rest and derives the token-signing key. */
export class Secrets {
  constructor(master) {
    this.encKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'hecate-secrets-v1', 32));
    this.jwtKey = Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'hecate-jwt-v1', 32));
  }
  seal(plain) {
    if (plain == null || plain === '') return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }
  unseal(sealed) {
    if (!sealed) return null;
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
}

/** Tiny fixed-window rate limiter. */
export class RateLimiter {
  constructor() { this.hits = new Map(); }
  check(key, limit, windowMs) {
    const t = Date.now();
    let e = this.hits.get(key);
    if (!e || t - e.start >= windowMs) { e = { start: t, n: 0 }; this.hits.set(key, e); }
    e.n += 1;
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (t - v.start > windowMs) this.hits.delete(k);
    if (e.n > limit) throw err(429, 'rate_limited', 'Too many requests, slow down', { retry_after: Math.ceil((e.start + windowMs - t) / 1000) });
  }
}
