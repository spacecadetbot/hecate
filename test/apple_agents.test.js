import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { boot, login, sse, types, startFakeLLM, startFakeHermes } from './helpers.js';

const BUNDLE = 'com.example.hecate';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken({ key = privateKey, kid = 'k1', aud = BUNDLE, iss = 'https://appleid.apple.com', exp = Math.floor(Date.now() / 1000) + 600, sub = 'apple-sub-1', nonce, email = 'o@example.com' } = {}) {
  const h = b64({ alg: 'RS256', kid }); const p = b64({ iss, aud, exp, iat: Math.floor(Date.now() / 1000), sub, email, ...(nonce ? { nonce } : {}) });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key).toString('base64url');
  return `${h}.${p}.${sig}`;
}

let jwks, ctx;
before(async () => {
  jwks = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  ctx = await boot({ appleBundleId: BUNDLE, devLogin: false, appleJwksUrl: `http://127.0.0.1:${jwks.address().port}/keys` });
});
after(async () => { await ctx.close(); jwks.closeAllConnections?.(); jwks.close(); });

const apple = (body) => ctx.api('POST', '/v1/auth/apple', { body });

test('Sign in with Apple: valid token creates the owner and issues our own tokens', async () => {
  const r = await apple({ identity_token: idToken(), full_name: 'Owen H', device_name: 'iPhone' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.user.role, 'owner');
  assert.equal(r.json.user.display_name, 'Owen H');
  assert.equal((await ctx.api('GET', '/v1/me', { token: r.json.access_token })).json.email, 'o@example.com');
  const again = await apple({ identity_token: idToken() });
  assert.equal(again.json.user.id, r.json.user.id, 'same Apple sub maps to the same user');
  assert.equal((await ctx.api('POST', '/v1/auth/dev', { body: { name: 'x' } })).status, 404, 'dev login disabled');
});

test('Sign in with Apple rejects bad tokens', async () => {
  const bad = [
    ['wrong audience', idToken({ aud: 'com.evil.app' })],
    ['expired', idToken({ exp: Math.floor(Date.now() / 1000) - 10 })],
    ['wrong issuer', idToken({ iss: 'https://evil.example' })],
    ['forged signature', idToken({ key: other.privateKey })],
    ['unknown key id', idToken({ kid: 'nope' })],
    ['garbage', 'not.a.jwt'],
  ];
  for (const [name, token] of bad) assert.equal((await apple({ identity_token: token })).status, 401, name);
});

test('Sign in with Apple checks the nonce (raw or SHA-256 hashed)', async () => {
  const raw = 'n-0S6_WzA2Mj';
  assert.equal((await apple({ identity_token: idToken({ nonce: raw, sub: 'apple-sub-1' }), nonce: raw })).status, 200);
  const hashed = crypto.createHash('sha256').update(raw).digest('hex');
  assert.equal((await apple({ identity_token: idToken({ nonce: hashed, sub: 'apple-sub-1' }), nonce: raw })).status, 200);
  assert.equal((await apple({ identity_token: idToken({ nonce: raw, sub: 'apple-sub-1' }), nonce: 'wrong' })).status, 401);
  assert.equal((await apple({ identity_token: idToken({ nonce: raw, sub: 'apple-sub-1' }) })).json.error.code, 'nonce_required');
});

test('new Apple users need an invite once the owner exists', async () => {
  const denied = await apple({ identity_token: idToken({ sub: 'apple-sub-2' }) });
  assert.equal(denied.status, 403);
  const owner = await apple({ identity_token: idToken() });
  const inv = await ctx.api('POST', '/v1/admin/invites', { token: owner.json.access_token, body: {} });
  const ok = await apple({ identity_token: idToken({ sub: 'apple-sub-2' }), invite_code: inv.json.code });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.role, 'user');
});

test('agents: Hermes attach, event translation, per-profile routing and approvals', async () => {
  const llm = await startFakeLLM(); const hermes = await startFakeHermes();
  const g = await boot();
  try {
    const o = await login(g, 'owen');
    assert.equal((await g.api('POST', '/v1/chats', { token: o.token, body: { agent_id: 'agt_nope' } })).status, 404);
    const before = await g.api('POST', '/v1/agents', { token: o.token, body: { name: 'Research Buddy', persona: 'You research things.' } });
    assert.equal(before.status, 201);
    assert.match(before.json.hermes_profile, /--research-buddy$/);
    const c0 = (await g.api('POST', '/v1/chats', { token: o.token, body: { agent_id: before.json.id } })).json.id;
    const notAttached = await sse(g, `/v1/chats/${c0}/messages`, { token: o.token, method: 'POST', body: { text: 'hi', stream: true } });
    assert.equal(notAttached.events.at(-1).data.error.code, 'hermes_not_configured');

    const st = await g.api('POST', '/v1/admin/hermes', { token: o.token, body: { url: hermes.url, api_key: 'sekret', mode: 'sessions' } });
    assert.equal(st.json.reachable, true);
    assert.equal(g.gw.db.get("SELECT value FROM settings WHERE key = 'hermes_key_enc'").value.startsWith('"v1:'), true, 'key is stored encrypted');
    assert.equal(JSON.stringify((await g.api('GET', '/v1/admin/settings', { token: o.token })).json).includes('sekret'), false);
    const agent = (await g.api('PATCH', `/v1/agents/${before.json.id}`, { token: o.token, body: { hermes_profile: 'buddy' } })).json;

    const c = (await g.api('POST', '/v1/chats', { token: o.token, body: { agent_id: agent.id } })).json.id;
    const started = await g.api('POST', `/v1/chats/${c}/messages`, { token: o.token, body: { text: 'check the folder' } });
    const runId = started.json.run.id;
    const seen = [];
    const stream = await sse(g, `/v1/runs/${runId}/events`, { token: o.token, until: (t, d) => { seen.push(t); return t === 'approval.request'; } });
    const req = stream.events.at(-1).data;
    assert.equal(req.request_id, 'ap1');
    const ap = await g.api('POST', `/v1/runs/${runId}/approval`, { token: o.token, body: { request_id: req.request_id, execution_generation: req.execution_generation, choice: 'once' } });
    assert.equal(ap.status, 200);
    assert.deepEqual(hermes.seen.approvals[0], { request_id: 'ap1', execution_generation: 3, choice: 'once' });
    assert.ok(hermes.seen.paths.includes('POST /p/buddy/v1/runs/hrun_1/approval'));
    const rest = await sse(g, `/v1/runs/${runId}/events?after=${req.seq}`, { token: o.token });
    const all = [...stream.events, ...rest.events];
    const t = types(all);
    for (const need of ['thinking.delta', 'tool.started', 'tool.completed', 'assistant.delta', 'approval.resolved', 'message.completed', 'run.completed']) assert.ok(t.includes(need), `missing ${need}: ${t}`);
    const msg = (await g.api('GET', `/v1/chats/${c}/messages`, { token: o.token })).json.messages[1];
    assert.equal(msg.text, 'Agent done.');
    assert.match(msg.reasoning, /Considering/);
    assert.ok(hermes.seen.paths.some((p) => p === `POST /p/buddy/api/sessions/hecate-${c}/chat/stream`));
    assert.ok(hermes.seen.auth.every((a) => a === 'Bearer sekret'));
    assert.deepEqual(hermes.seen.bodies.find((b) => b.message), { message: 'check the folder' });
  } finally { await g.close(); await llm.close(); await hermes.close(); }
});

test('orphaned runs are failed cleanly after a gateway restart', async () => {
  const g = await boot();
  try {
    const o = await login(g, 'owen');
    const chat = (await g.api('POST', '/v1/chats', { token: o.token, body: {} })).json.id;
    const d = g.gw.db;
    d.run("INSERT INTO messages(id, chat_id, user_id, role, text, status, created_at, updated_at) VALUES('m_u', ?, ?, 'user', 'hi', 'complete', 1, 1)", chat, o.user.id);
    d.run("INSERT INTO messages(id, chat_id, user_id, role, text, status, run_id, created_at, updated_at) VALUES('m_a', ?, ?, 'assistant', 'partial', 'streaming', 'run_x', 2, 2)", chat, o.user.id);
    d.run("INSERT INTO runs(id, user_id, chat_id, message_id, user_message_id, status, created_at) VALUES('run_x', ?, ?, 'm_a', 'm_u', 'running', 2)", o.user.id, chat);
    g.gw.app.runs.recoverOrphans();
    const run = (await g.api('GET', '/v1/runs/run_x', { token: o.token })).json;
    assert.equal(run.status, 'failed');
    assert.equal(run.error.code, 'gateway_restarted');
    const ev = await sse(g, '/v1/runs/run_x/events', { token: o.token });
    assert.equal(ev.events.at(-1).type, 'run.failed');
    const m = (await g.api('GET', `/v1/chats/${chat}/messages`, { token: o.token })).json.messages.at(-1);
    assert.deepEqual([m.status, m.text], ['failed', 'partial']);
  } finally { await g.close(); }
});
