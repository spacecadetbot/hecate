import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { Secrets, RateLimiter, HttpError, err, log, setLogLevel } from './util.js';
import { Settings } from './settings.js';
import { Auth } from './auth.js';
import { Registry } from './servers.js';
import { Media } from './media.js';
import { Memory } from './memory.js';
import { Hermes } from './hermes.js';
import { RunManager } from './runs.js';
import { Router, Reply, readJson, sendJson } from './http.js';
import { registerRoutes } from './routes.js';
import { registerAdmin } from './admin.js';
import { registerOpenAI } from './openai.js';
import { Search } from './search.js';

export function createGateway(overrides = {}) {
  const config = loadConfig(overrides);
  setLogLevel(config.logLevel);
  const db = openDb(path.join(config.dataDir, 'hecate.db'));
  const secrets = new Secrets(config.secret);
  const settings = new Settings(db, config);
  const auth = new Auth({ db, config, secrets, settings });
  const registry = new Registry({ db, config, secrets, settings });
  const media = new Media({ db, config, settings });
  const memory = new Memory({ db, registry, settings, config });
  const hermes = new Hermes({ db, settings, secrets });
  const search = new Search({ settings, secrets, baseUrl: process.env.HECATE_BRAVE_URL });
  const runs = new RunManager({ db, config, registry, media, memory, settings, hermes, search });
  const limiter = new RateLimiter();
  const app = { db, config, secrets, settings, auth, registry, media, memory, hermes, search, runs, limiter };

  const router = new Router();
  registerRoutes(router, app);
  registerAdmin(router, app);
  registerOpenAI(router, app);

  const isAdmin = (u) => u.role === 'owner' || u.role === 'admin';

  async function dispatch(req, res) {
    const t0 = Date.now(); let status = 500;
    try {
      const url = new URL(req.url, 'http://gateway');
      const m = router.match(req.method, url.pathname);
      if (!m.route) throw m.pathMatched ? err(405, 'method_not_allowed', 'Method not allowed') : err(404, 'not_found', 'No such endpoint');
      const { route, params } = m;
      const c = { req, res, params, query: Object.fromEntries(url.searchParams), url, app };
      const mode = route.opts.auth ?? 'user';
      if (mode !== 'none') {
        limiter.check(`ip:${req.socket.remoteAddress}`, 1500, 60_000);
        const a = auth.authenticate(req);
        registry.touch();
        if (mode === 'service') {
          if (a.kind === 'user' && !isAdmin(a.user)) throw err(403, 'forbidden', 'This endpoint needs a service key or an admin token');
          c.principal = a;
        } else {
          if (a.kind !== 'user') throw err(403, 'forbidden', 'This endpoint needs a user token');
          if (mode === 'admin' && !isAdmin(a.user)) throw err(403, 'forbidden', 'Admin access required');
          c.user = a.user; c.sessionId = a.sessionId;
        }
      }
      if (!route.opts.raw && ['POST', 'PUT', 'PATCH'].includes(req.method)) c.body = await readJson(req, mode === 'service' ? 50_000_000 : 2_000_000);
      const out = await route.handler(c);
      if (res.headersSent) { status = res.statusCode; return; }
      if (out instanceof Reply) { status = out.status; sendJson(res, out.status, out.body, out.headers); }
      else if (out === undefined) { status = 204; res.writeHead(204); res.end(); }
      else { status = 200; sendJson(res, 200, out); }
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        if (res.headersSent) return res.end();
        sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } }, e.extra?.retry_after ? { 'Retry-After': e.extra.retry_after } : {});
      } else {
        log.error(`${req.method} ${req.url}`, e);
        if (res.headersSent) return res.end();
        sendJson(res, 500, { error: { code: 'internal_error', message: 'Unexpected gateway error' } });
      }
    } finally { log.debug(`${req.method} ${req.url} -> ${status} (${Date.now() - t0} ms)`); }
  }

  const server = http.createServer(dispatch);
  server.requestTimeout = 0;          // large uploads and long streams must not be cut off
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  let pruneTimer;

  return {
    config, db, app, server, router,
    async start() {
      runs.recoverOrphans();
      runs.pruneEvents();
      pruneTimer = setInterval(() => runs.pruneEvents(), 6 * 3600_000); pruneTimer.unref?.();
      registry.start();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      return server.address().port;
    },
    async stop() {
      clearInterval(pruneTimer); registry.stop();
      for (const e of runs.active.values()) e.abort.abort();
      await new Promise((r) => setTimeout(r, 50));
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}

function banner(gw, port) {
  const { config, db } = gw;
  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  const users = db.get('SELECT COUNT(*) AS c FROM users').c;
  log.info(`Hecate Gateway ${config.version} listening on port ${port}`);
  for (const ip of ips) log.info(`  LAN address: http://${ip}:${port}`);
  log.info(`  data directory: ${config.dataDir}`);
  if (!config.appleBundleId && !config.devLogin) log.warn('Sign-in is not configured: set HECATE_APPLE_BUNDLE_ID (or HECATE_DEV_LOGIN=1 while developing).');
  if (config.devLogin) log.warn('Developer login is ENABLED (POST /v1/auth/dev). Turn it off before exposing this server.');
  log.info(users === 0 ? '  no users yet: the first person to sign in becomes the owner' : `  ${users} user(s)`);
  if (!config.ffmpeg) log.warn('ffmpeg not found: no thumbnails, no video frame sampling, no audio conversion.');
  if (!config.pdftotext) log.warn('pdftotext not found: PDF attachments cannot be read (apt install poppler-utils).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gw = createGateway();
  gw.start().then((port) => banner(gw, port)).catch((e) => { log.error('failed to start:', e.message); process.exit(1); });
  const down = async () => { log.info('shutting down...'); await gw.stop().catch(() => {}); process.exit(0); };
  process.on('SIGINT', down); process.on('SIGTERM', down);
}
