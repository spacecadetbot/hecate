import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../src/server.js';
import { readSSE } from '../src/llm.js';

const readJsonBody = async (req) => { const c = []; for await (const x of req) c.push(x); const t = Buffer.concat(c).toString(); return t ? JSON.parse(t) : {}; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

const flat = (content) => (typeof content === 'string' ? content : (content ?? []).filter((p) => p.type === 'text').map((p) => p.text).join(' '));

/** A fake OpenAI-compatible model server (LM Studio flavoured). */
export async function startFakeLLM(opts = {}) {
  const state = { requests: [], models: opts.models ?? ['gemma-4-e4b-it', 'text-embedding-nomic-embed-text-v1.5'], failAll: false, rejectVideo: false, closedEarly: 0, transcriptions: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: state.models.map((id) => ({ id, object: 'model' })) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/models' && !state.noV1) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ models: state.models.map((id) => ({
        type: /embed/.test(id) ? 'embedding' : 'llm', publisher: 'x', key: id, display_name: id,
        capabilities: /embed/.test(id) ? undefined : { vision: /gemma|vl/.test(id) },
        loaded_instances: /gemma/.test(id) ? [{ id, config: {} }] : [], max_context_length: 32768, format: 'gguf',
      })) }));
    }
    if (req.method === 'GET' && url.pathname === '/api/v0/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: state.models.map((id) => ({ id, type: /embed/.test(id) ? 'embeddings' : 'llm' })) }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
      const b = await readJsonBody(req);
      const inputs = Array.isArray(b.input) ? b.input : [b.input];
      const data = inputs.map((t, index) => {
        const v = new Array(16).fill(0);
        for (const w of String(t).toLowerCase().match(/[a-z]+/g) ?? []) { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 16; v[h] += 1; }
        return { index, embedding: v };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      state.transcriptions++;
      for await (const _ of req) { /* drain */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ text: 'hello from the recording' }));
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const b = await readJsonBody(req);
      state.requests.push(b);
      if (state.failAll) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'boom' })); }
      const last = b.messages.at(-1);
      const parts = Array.isArray(last.content) ? last.content : [];
      if (state.rejectVideo && parts.some((p) => p.type === 'video_url')) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'video not supported' })); }
      const text = flat(last.content);
      const system = flat(b.messages[0]?.content);
      let reply; let slow = false;
      if (system.includes('long-term memory about the user')) reply = '["Owen likes testing gateways"]';
      else if (system.includes('Write a title')) reply = '"Gateway Test Chat."';
      else if (text.includes('SLOW')) { reply = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' '); slow = true; }
      else if (text.includes('THINKTAG')) reply = '<th|ink>hidden thoughts</think>Visible answer';
      else if (parts.some((p) => p.type === 'input_audio')) reply = 'Heard audio.';
      else if (parts.some((p) => p.type === 'video_url')) reply = 'Saw native video.';
      else if (parts.some((p) => p.type === 'image_url')) reply = `Saw ${parts.filter((p) => p.type === 'image_url').length} image(s).`;
      else reply = `Echo: ${text}`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.on('close', () => { if (!res.writableEnded) state.closedEarly++; });
      const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, ...extra }] })}\n\n`);
      if (/gpt-oss|reason/.test(b.model) || b.reasoning_effort) { send({ reasoning_content: 'Thinking. ' }); await sleep(10); send({ reasoning_content: 'Still thinking. ' }); await sleep(10); }
      for (const tok of reply.split(/(?<= )|\|/)) {
        if (res.writableEnded || res.destroyed) return;
        send({ content: tok }); await sleep(slow ? 25 : 3);
      }
      send({}, { finish_reason: 'stop' });
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

/** A fake Hermes API server (sessions mode event stream, approvals, /p/<profile> routing). */
export async function startFakeHermes() {
  const seen = { paths: [], auth: [], approvals: [], bodies: [] };
  const server = http.createServer(async (req, res) => {
    seen.paths.push(`${req.method} ${req.url}`); seen.auth.push(req.headers.authorization);
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    seen.bodies.push(body);
    if (req.url.endsWith('/v1/capabilities')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"api":"hermes"}'); }
    if (req.url.endsWith('/api/sessions') && req.method === 'POST') { res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    if (/\/api\/sessions\/[^/]+\/chat\/stream$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      ev('run.started', { run_id: 'hrun_1' });
      ev('tool.progress', { tool_name: '_thinking', delta: 'Considering the request. ' });
      ev('tool.started', { tool_name: 'terminal', preview: 'ls', args: { cmd: 'ls' } });
      ev('approval.request', { run_id: 'hrun_1', request_id: 'ap1', execution_generation: 3, command: 'ls' });
      await sleep(150);
      ev('tool.completed', { tool_name: 'terminal', preview: 'ok' });
      ev('assistant.delta', { delta: 'Agent ' }); ev('assistant.delta', { delta: 'done.' });
      ev('assistant.completed', { content: 'Agent done.', usage: { total_tokens: 5 } });
      ev('run.completed', {}); res.write('event: done\ndata: {}\n\n');
      return res.end();
    }
    if (/\/v1\/runs\/[^/]+\/approval$/.test(req.url)) { seen.approvals.push(body); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

export async function boot(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hecate-test-'));
  const gw = createGateway({ dataDir, port: 0, host: '127.0.0.1', devLogin: true, noDotEnv: true, logLevel: 'error', healthIntervalMs: 600000, ...overrides });
  const port = await gw.start();
  const base = `http://127.0.0.1:${port}`;
  async function api(method, p, { token, body, headers = {}, raw } = {}) {
    const res = await fetch(base + p, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  return { gw, base, api, dataDir, async close() { await gw.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

export async function login(ctx, name, inviteCode) {
  const r = await ctx.api('POST', '/v1/auth/dev', { body: { name, invite_code: inviteCode } });
  if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
  return { token: r.json.access_token, refresh: r.json.refresh_token, user: r.json.user };
}

/** Reads an SSE endpoint until `until(type, data)` is true or the stream ends. */
export async function sse(ctx, p, { token, method = 'GET', body, until } = {}) {
  const res = await fetch(ctx.base + p, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const events = [];
  if (!res.ok) return { status: res.status, events, json: await res.json().catch(() => null) };
  for await (const ev of readSSE(res.body)) {
    const data = JSON.parse(ev.data);
    events.push({ type: ev.event, data });
    if (until?.(ev.event, data)) break;
  }
  return { status: res.status, events };
}
export const types = (events) => events.map((e) => e.type);

export async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await sleep(40);
  }
}
