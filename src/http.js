import { err } from './util.js';

export class Reply {
  constructor(status, body, headers = {}) { this.status = status; this.body = body; this.headers = headers; }
}
export const created = (body) => new Reply(201, body);

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, opts = {}) {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, names, handler, opts, pattern });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }
  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return { pathMatched };
  }
}

export async function readBody(req, limit = 2_000_000) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw err(413, 'payload_too_large', 'Request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
export async function readJson(req, limit) {
  const b = await readBody(req, limit);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw err(400, 'invalid_json', 'Request body must be valid JSON'); }
}

export function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

/** Opens a Server-Sent-Events response. Events are {seq, type, data}. */
export function openSSE(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.socket?.setTimeout(0);
  res.socket?.setNoDelay(true);
  res.write(': connected\n\n');
  const ka = setInterval(() => { if (!res.writableEnded) res.write(': keepalive\n\n'); }, 10000);
  ka.unref?.();
  res.on('close', () => clearInterval(ka));
  return {
    send(ev) {
      if (res.writableEnded) return;
      res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    },
    end() { clearInterval(ka); if (!res.writableEnded) res.end(); },
  };
}
