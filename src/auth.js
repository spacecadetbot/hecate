import crypto from 'node:crypto';
import { err, newId, now, iso, sha256hex, randomToken, b64url, parseJson, safeEqual, log } from './util.js';

const HOUR = 3600_000;

export class Auth {
  constructor({ db, config, secrets, settings }) {
    this.db = db; this.config = config; this.secrets = secrets; this.settings = settings;
    this.jwks = { keys: null, fetchedAt: 0, lastAttempt: 0 };
  }

  // ---------- our own tokens ----------
  signAccess(user, sessionId) {
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const iat = Math.floor(now() / 1000);
    const payload = b64url(JSON.stringify({ iss: 'hecate-gateway', sub: user.id, sid: sessionId, iat, exp: iat + this.config.accessTtlSec }));
    const sig = crypto.createHmac('sha256', this.secrets.jwtKey).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${sig}`;
  }
  verifyAccess(token) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw err(401, 'invalid_token', 'Malformed token');
    const expect = crypto.createHmac('sha256', this.secrets.jwtKey).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!safeEqual(expect, parts[2])) throw err(401, 'invalid_token', 'Bad token signature');
    const claims = parseJson(Buffer.from(parts[1], 'base64url').toString('utf8'), null);
    if (!claims || claims.exp < Math.floor(now() / 1000)) throw err(401, 'token_expired', 'Access token expired');
    return claims;
  }

  publicUser(u) {
    return { id: u.id, display_name: u.display_name, email: u.email, role: u.role, show_disclaimer: u.show_disclaimer !== 0, created_at: iso(u.created_at) };
  }

  // ---------- sessions ----------
  openSession(user, deviceName) {
    const sid = newId('ses');
    const refresh = randomToken('rt');
    const t = now();
    this.db.run(
      `INSERT INTO auth_sessions(id, user_id, device_name, refresh_hash, created_at, last_used_at, expires_at) VALUES(?,?,?,?,?,?,?)`,
      sid, user.id, deviceName ?? null, sha256hex(refresh), t, t, t + this.config.refreshTtlDays * 24 * HOUR,
    );
    return this.#tokens(user, sid, refresh);
  }
  #tokens(user, sid, refresh) {
    return {
      access_token: this.signAccess(user, sid),
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: this.config.accessTtlSec,
      user: this.publicUser(user),
    };
  }
  refresh(refreshToken) {
    const h = sha256hex(String(refreshToken ?? ''));
    return this.db.tx(() => {
      let s = this.db.get('SELECT * FROM auth_sessions WHERE refresh_hash = ?', h);
      if (!s) {
        const reused = this.db.get('SELECT * FROM auth_sessions WHERE prev_refresh_hash = ?', h);
        // A just-rotated token may be replayed once after a lost response; anything older means theft.
        if (reused && !reused.revoked && now() - reused.last_used_at < 60_000) s = reused;
        else {
          if (reused) this.db.run('UPDATE auth_sessions SET revoked = 1 WHERE id = ?', reused.id);
          throw err(401, 'invalid_refresh_token', 'Refresh token is invalid or was already used');
        }
      }
      if (s.revoked || s.expires_at < now()) throw err(401, 'invalid_refresh_token', 'Session expired');
      const user = this.db.get('SELECT * FROM users WHERE id = ?', s.user_id);
      if (!user || user.disabled) throw err(403, 'account_disabled', 'This account is disabled');
      const next = randomToken('rt');
      this.db.run(
        'UPDATE auth_sessions SET refresh_hash = ?, prev_refresh_hash = ?, last_used_at = ?, expires_at = ? WHERE id = ?',
        sha256hex(next), s.refresh_hash === h ? h : s.prev_refresh_hash, now(), now() + this.config.refreshTtlDays * 24 * HOUR, s.id,
      );
      return this.#tokens(user, s.id, next);
    });
  }
  revokeSession(sid, userId) {
    this.db.run('UPDATE auth_sessions SET revoked = 1 WHERE id = ? AND user_id = ?', sid, userId);
  }

  /** Bearer authentication: returns {kind:'user', user, sessionId} or {kind:'service', key}. */
  authenticate(req) {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw err(401, 'unauthenticated', 'Missing bearer token');
    const token = m[1].trim();
    if (token.startsWith('hk_')) {
      const key = this.db.get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0', sha256hex(token));
      if (!key) throw err(401, 'invalid_token', 'Unknown API key');
      if (!key.last_used_at || now() - key.last_used_at > 60_000) this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), key.id);
      return { kind: 'service', key };
    }
    const claims = this.verifyAccess(token);
    const s = this.db.get('SELECT revoked, expires_at FROM auth_sessions WHERE id = ?', claims.sid);
    if (!s || s.revoked || s.expires_at < now()) throw err(401, 'session_revoked', 'Session is no longer valid');
    const user = this.db.get('SELECT * FROM users WHERE id = ?', claims.sub);
    if (!user) throw err(401, 'invalid_token', 'Unknown user');
    if (user.disabled) throw err(403, 'account_disabled', 'This account is disabled');
    if (!user.last_seen_at || now() - user.last_seen_at > 60_000) this.db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), user.id);
    return { kind: 'user', user, sessionId: claims.sid };
  }

  // ---------- admission ----------
  loginOrRegister({ sub, email, fullName, inviteCode }) {
    return this.db.tx(() => {
      let user = this.db.get('SELECT * FROM users WHERE apple_sub = ?', sub);
      if (user) {
        if (user.disabled) throw err(403, 'account_disabled', 'This account is disabled');
        if ((!user.email && email) || (!user.display_name && fullName)) {
          this.db.run('UPDATE users SET email = COALESCE(email, ?), display_name = COALESCE(display_name, ?) WHERE id = ?', email ?? null, fullName ?? null, user.id);
          user = this.db.get('SELECT * FROM users WHERE id = ?', user.id);
        }
        return user;
      }
      const total = this.db.get('SELECT COUNT(*) AS c FROM users').c;
      const real = this.db.get("SELECT COUNT(*) AS c FROM users WHERE apple_sub NOT LIKE 'dev:%' AND apple_sub NOT LIKE 'local:%'").c;
      const isDev = sub.startsWith('dev:'); const isLocal = sub.startsWith('local:');
      let role = 'user'; let needInvite = true;
      // The first REAL (Apple) user becomes the owner, even if developer-login accounts were used for testing first.
      if (isLocal) needInvite = false;
      else if (isDev) { if (total === 0) { needInvite = false; role = this.config.appleBundleId ? 'user' : 'owner'; } }
      else if (real === 0) { needInvite = false; role = 'owner'; }
      if (needInvite && !this.settings.get('open_signup')) {
        const code = String(inviteCode ?? '').trim().toUpperCase();
        const inv = code && this.db.get('SELECT * FROM invites WHERE code = ?', code);
        if (!inv || inv.revoked || inv.uses >= inv.max_uses || (inv.expires_at && inv.expires_at < now())) {
          throw err(403, 'invite_required', 'This server is invite-only. Ask the owner for an invite code.');
        }
        this.db.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
      }
      const id = newId('usr');
      this.db.run('INSERT INTO users(id, apple_sub, email, display_name, role, created_at, last_seen_at) VALUES(?,?,?,?,?,?,?)',
        id, sub, email ?? null, fullName ?? null, role, now(), now());
      log.info(`new user ${id} (${role})`);
      return this.db.get('SELECT * FROM users WHERE id = ?', id);
    });
  }

  /** A passwordless in-process account for the terminal chat client (never becomes the owner). */
  localUser(name) {
    return this.loginOrRegister({ sub: `local:${name}`, email: null, fullName: name, inviteCode: null });
  }

  // ---------- Sign in with Apple ----------
  async #refreshJwks(force = false) {
    const t = now();
    if (!force && this.jwks.keys && t - this.jwks.lastAttempt < 30_000) return;
    this.jwks.lastAttempt = t;
    try {
      const res = await fetch(this.config.appleJwksUrl, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      this.jwks.keys = j.keys ?? [];
      this.jwks.fetchedAt = t;
    } catch (e) {
      log.warn('could not fetch Apple signing keys:', e.message);
      if (!this.jwks.keys) throw err(503, 'apple_unreachable', 'The gateway could not reach Apple to verify your sign-in. Check its internet connection.');
    }
  }
  async verifyAppleIdentityToken(identityToken, nonce) {
    if (!this.config.appleBundleId) throw err(503, 'apple_not_configured', 'Sign in with Apple is not configured (set HECATE_APPLE_BUNDLE_ID).');
    const parts = String(identityToken ?? '').split('.');
    if (parts.length !== 3) throw err(401, 'invalid_token', 'Malformed identity token');
    const header = parseJson(Buffer.from(parts[0], 'base64url').toString('utf8'), {});
    if (header.alg !== 'RS256') throw err(401, 'invalid_token', 'Unsupported token algorithm');
    if (!this.jwks.keys || now() - this.jwks.fetchedAt > 6 * HOUR) await this.#refreshJwks(true);
    let jwk = this.jwks.keys?.find((k) => k.kid === header.kid);
    if (!jwk) { await this.#refreshJwks(); jwk = this.jwks.keys?.find((k) => k.kid === header.kid); }
    if (!jwk) throw err(401, 'invalid_token', 'Unknown Apple signing key');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw err(401, 'invalid_token', 'Identity token signature is invalid');
    const c = parseJson(Buffer.from(parts[1], 'base64url').toString('utf8'), {});
    const t = Math.floor(now() / 1000);
    const audiences = this.config.appleBundleId.split(',').map((s) => s.trim()).filter(Boolean);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (c.iss !== this.config.appleIssuer) throw err(401, 'invalid_token', 'Wrong token issuer');
    if (!aud.some((a) => audiences.includes(a))) throw err(401, 'invalid_token', 'Token was issued for a different app');
    if (!c.exp || c.exp < t) throw err(401, 'invalid_token', 'Identity token expired');
    if (c.iat && c.iat > t + 300) throw err(401, 'invalid_token', 'Identity token issued in the future');
    if (!c.sub) throw err(401, 'invalid_token', 'Identity token has no subject');
    if (c.nonce) {
      if (!nonce) throw err(401, 'nonce_required', 'This token carries a nonce; send it as "nonce"');
      if (c.nonce !== nonce && c.nonce !== sha256hex(nonce)) throw err(401, 'invalid_nonce', 'Nonce does not match');
    }
    return { sub: c.sub, email: c.email ?? null };
  }
}
