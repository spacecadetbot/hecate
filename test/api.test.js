import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, sse, types, startFakeLLM, waitFor, sleep } from './helpers.js';

let ctx, llm, owner, bob, chatId;

before(async () => {
  llm = await startFakeLLM({ models: ['gemma-4-e4b-it', 'gpt-oss-20b', 'text-embedding-nomic-embed-text-v1.5'] });
  ctx = await boot();
  owner = await login(ctx, 'owen');
});
after(async () => { await ctx.close(); await llm.close(); });

test('capabilities are public and report setup state', async () => {
  const r = await ctx.api('GET', '/v1/capabilities');
  assert.equal(r.status, 200);
  assert.equal(r.json.api_version, 1);
  assert.ok(r.json.events.includes('thinking.delta'));
  assert.equal((await ctx.api('GET', '/v1/chats')).status, 401);
});

test('first user is owner; others need an invite', async () => {
  assert.equal(owner.user.role, 'owner');
  const denied = await ctx.api('POST', '/v1/auth/dev', { body: { name: 'bob' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.error.code, 'invite_required');
  const inv = await ctx.api('POST', '/v1/admin/invites', { token: owner.token, body: { note: 'bob' } });
  assert.equal(inv.status, 201);
  bob = await login(ctx, 'bob', inv.json.code);
  assert.equal(bob.user.role, 'user');
  const reuse = await ctx.api('POST', '/v1/auth/dev', { body: { name: 'carol', invite_code: inv.json.code } });
  assert.equal(reuse.status, 403, 'single-use invite cannot be reused');
  assert.equal((await ctx.api('GET', '/v1/admin/users', { token: bob.token })).status, 403);
});

test('refresh rotates tokens, tolerates one replay, and detects theft', async () => {
  const s = await login(ctx, 'owen');
  const r1 = await ctx.api('POST', '/v1/auth/refresh', { body: { refresh_token: s.refresh } });
  assert.equal(r1.status, 200);
  assert.notEqual(r1.json.refresh_token, s.refresh);
  assert.equal((await ctx.api('GET', '/v1/me', { token: r1.json.access_token })).json.display_name, 'owen');
  const replay = await ctx.api('POST', '/v1/auth/refresh', { body: { refresh_token: s.refresh } });
  assert.equal(replay.status, 200, 'a just-rotated token may be replayed once (lost response)');
  assert.equal((await ctx.api('POST', '/v1/auth/refresh', { body: { refresh_token: 'rt_nonsense' } })).status, 401);
});

test('logout revokes the session immediately', async () => {
  const s = await login(ctx, 'owen');
  assert.equal((await ctx.api('GET', '/v1/me', { token: s.token })).status, 200);
  await ctx.api('POST', '/v1/auth/logout', { token: s.token });
  assert.equal((await ctx.api('GET', '/v1/me', { token: s.token })).status, 401);
});

test('admin adds a model server; models are discovered with capability guesses', async () => {
  const bad = await ctx.api('POST', '/v1/admin/servers', { token: owner.token, body: { name: 'nope', base_url: 'ftp://x' } });
  assert.equal(bad.status, 400);
  const r = await ctx.api('POST', '/v1/admin/servers', { token: owner.token, body: { name: 'fake', base_url: llm.url + '/v1', default_tier: 'fast' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.validation.ok, true);
  assert.equal(r.json.server.status, 'healthy');
  const models = (await ctx.api('GET', '/v1/admin/models', { token: owner.token })).json.models;
  const gemma = models.find((m) => m.upstream_id === 'gemma-4-e4b-it');
  assert.deepEqual(gemma.capabilities.sort(), ['audio', 'text', 'tools', 'video', 'vision']);
  assert.ok(models.find((m) => m.upstream_id.includes('embed')).capabilities.includes('embedding'));
  const pub = (await ctx.api('GET', '/v1/models', { token: bob.token })).json.models;
  assert.ok(!pub.some((m) => m.capabilities.includes('embedding')), 'embedding models are not offered for chat');
  const oss = models.find((m) => m.upstream_id === 'gpt-oss-20b');
  const patched = await ctx.api('PATCH', `/v1/admin/models/${oss.id}`, { token: owner.token, body: { tier: 'smart' } });
  assert.equal(patched.json.tier, 'smart');
});

test('streams thinking then answer over SSE, persists everything, builds history', async () => {
  chatId = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const r = await sse(ctx, `/v1/chats/${chatId}/messages`, { token: owner.token, method: 'POST', body: { text: 'hello there', stream: true } });
  const t = types(r.events);
  assert.equal(t[0], 'message.created');
  for (const need of ['run.started', 'model.selected', 'assistant.delta', 'message.completed', 'run.completed']) assert.ok(t.includes(need), `missing ${need}`);
  assert.equal(t.at(-1), 'run.completed');
  const text = r.events.filter((e) => e.type === 'assistant.delta').map((e) => e.data.delta).join('');
  assert.equal(text, 'Echo: hello there');
  const seqs = r.events.slice(1).map((e) => e.data.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'sequence numbers are gapless');

  const msgs = (await ctx.api('GET', `/v1/chats/${chatId}/messages`, { token: owner.token })).json.messages;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].text, 'Echo: hello there');
  assert.equal(msgs[1].status, 'complete');
  assert.equal(msgs[1].usage.completion_tokens, 7);

  await sse(ctx, `/v1/chats/${chatId}/messages`, { token: owner.token, method: 'POST', body: { text: 'second', stream: true } });
  const upstream = llm.state.requests.filter((q) => q.model === 'gemma-4-e4b-it').at(-1).messages;
  assert.equal(upstream[0].role, 'system');
  assert.deepEqual(upstream.slice(1).map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(upstream[1].content, 'hello there');
});

test('think harder routes to the smart tier and streams reasoning', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'ponder', think_harder: true, stream: true } });
  const sel = r.events.find((e) => e.type === 'model.selected').data;
  assert.equal(sel.tier, 'smart');
  assert.ok(types(r.events).indexOf('thinking.delta') < types(r.events).indexOf('assistant.delta'));
  assert.ok(types(r.events).includes('thinking.done'));
  const last = llm.state.requests.filter((q) => q.model === 'gpt-oss-20b').at(-1);
  assert.equal(last.reasoning_effort, 'high');
  const m = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1];
  assert.match(m.reasoning, /Thinking/);
  assert.ok(m.thinking_ms >= 0);
});

test('<think> tags in plain content are split into reasoning', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'THINKTAG please', stream: true } });
  assert.equal(r.events.filter((e) => e.type === 'assistant.delta').map((e) => e.data.delta).join(''), 'Visible answer');
  assert.equal(r.events.filter((e) => e.type === 'thinking.delta').map((e) => e.data.delta).join(''), 'hidden thoughts');
});

test('runs continue without a client and can be resumed from any sequence number', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const started = await ctx.api('POST', `/v1/chats/${c}/messages`, { token: owner.token, body: { text: 'SLOW story' } });
  assert.equal(started.status, 202);
  const runId = started.json.run.id;
  const first = await sse(ctx, `/v1/runs/${runId}/events`, { token: owner.token, until: (t) => t === 'assistant.delta' });
  const lastSeq = first.events.at(-1).data.seq;
  const chatNow = (await ctx.api('GET', `/v1/chats/${c}`, { token: owner.token })).json;
  assert.equal(chatNow.active_run_id, runId, 'chat reports its active run so the app can reattach');
  const busy = await ctx.api('POST', `/v1/chats/${c}/messages`, { token: owner.token, body: { text: 'again' } });
  assert.equal(busy.status, 409);
  await sleep(200);
  const rest = await sse(ctx, `/v1/runs/${runId}/events?after=${lastSeq}`, { token: owner.token });
  assert.ok(rest.events[0].data.seq > lastSeq);
  assert.equal(rest.events.at(-1).type, 'run.completed');
  const full = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1];
  assert.ok(full.text.startsWith('w0 w1'));
  assert.ok(full.text.endsWith('w199'));
  const replay = await sse(ctx, `/v1/runs/${runId}/events`, { token: owner.token });
  assert.equal(replay.events.at(-1).type, 'run.completed', 'finished runs replay from the log');
});

test('cancel stops the upstream request and keeps the partial answer', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const before = llm.state.closedEarly;
  const started = await ctx.api('POST', `/v1/chats/${c}/messages`, { token: owner.token, body: { text: 'SLOW again' } });
  const runId = started.json.run.id;
  await sse(ctx, `/v1/runs/${runId}/events`, { token: owner.token, until: (t) => t === 'assistant.delta' });
  await ctx.api('POST', `/v1/runs/${runId}/cancel`, { token: owner.token });
  await waitFor(async () => (await ctx.api('GET', `/v1/runs/${runId}`, { token: owner.token })).json.status === 'cancelled');
  const m = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1];
  assert.equal(m.status, 'cancelled');
  assert.ok(m.text.length > 0 && !m.text.endsWith('w199'));
  await waitFor(() => llm.state.closedEarly > before);
});

test('users are isolated from each other', async () => {
  const msgs = await ctx.api('GET', `/v1/chats/${chatId}/messages`, { token: bob.token });
  assert.equal(msgs.status, 404);
  const run = (await ctx.api('GET', `/v1/chats/${chatId}/messages`, { token: owner.token })).json.messages[1].run_id;
  assert.equal((await ctx.api('GET', `/v1/runs/${run}`, { token: bob.token })).status, 404);
  assert.equal((await ctx.api('POST', `/v1/runs/${run}/cancel`, { token: bob.token })).status, 404);
  assert.equal((await ctx.api('GET', '/v1/chats', { token: bob.token })).json.chats.length, 0);
  assert.equal((await ctx.api('DELETE', `/v1/chats/${chatId}`, { token: bob.token })).status, 404);
  const s = await ctx.api('GET', '/v1/search?q=hello', { token: bob.token });
  assert.equal(s.json.messages.length, 0);
});

test('client_message_id makes retries idempotent', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const a = await ctx.api('POST', `/v1/chats/${c}/messages`, { token: owner.token, body: { text: 'once', client_message_id: 'abc-1' } });
  await waitFor(async () => (await ctx.api('GET', `/v1/runs/${a.json.run.id}`, { token: owner.token })).json.status === 'completed');
  const b = await ctx.api('POST', `/v1/chats/${c}/messages`, { token: owner.token, body: { text: 'once', client_message_id: 'abc-1' } });
  assert.equal(b.json.deduplicated, true);
  assert.equal(b.json.user_message.id, a.json.user_message.id);
  assert.equal((await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages.length, 2);
});

test('regenerate replaces the last answer', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'redo me', stream: true } });
  const r = await sse(ctx, `/v1/chats/${c}/regenerate`, { token: owner.token, method: 'POST', body: { stream: true } });
  assert.equal(r.events.at(-1).type, 'run.completed');
  const msgs = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
});

test('regenerate with edit_text rewrites the last user message', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'first wording', stream: true } });
  const r = await sse(ctx, `/v1/chats/${c}/regenerate`, { token: owner.token, method: 'POST', body: { stream: true, edit_text: 'better wording' } });
  assert.equal(r.events.at(-1).type, 'run.completed');
  const msgs = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.equal(msgs[0].text, 'better wording');
  assert.equal(msgs[1].text, 'Echo: better wording');
});

test('personal rules are added to the prompt of normal chats', async () => {
  const bad = await ctx.api('PATCH', '/v1/me', { token: owner.token, body: { rules: 'x'.repeat(8001) } });
  assert.equal(bad.status, 400);
  const set = await ctx.api('PATCH', '/v1/me', { token: owner.token, body: { rules: 'Always answer in exactly three words.' } });
  assert.equal(set.json.rules, 'Always answer in exactly three words.');
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'rules check', stream: true } });
  const req = llm.state.requests.filter((b) => JSON.stringify(b.messages.at(-1)).includes('rules check')).at(-1);
  assert.match(req.messages[0].content, /standing rules[\s\S]*exactly three words/);
  assert.ok(req.messages[0].content.includes('You are Hecate'), 'the gateway base prompt stays');
  // another person does not get them
  const other = (await ctx.api('GET', '/v1/me', { token: bob.token })).json;
  assert.equal(other.rules, '');
  await ctx.api('PATCH', '/v1/me', { token: owner.token, body: { rules: '' } });
});

test('falls back to another server when the preferred one fails', async () => {
  const llm2 = await startFakeLLM({ models: ['backup-model'] });
  const add = await ctx.api('POST', '/v1/admin/servers', { token: owner.token, body: { name: 'backup', base_url: llm2.url, default_tier: 'fast' } });
  assert.equal(add.status, 201);
  llm.state.failAll = true;
  try {
    const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
    const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'survive', stream: true } });
    assert.ok(types(r.events).includes('model.fallback'));
    assert.equal(r.events.at(-1).type, 'run.completed');
    assert.equal((await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1].text, 'Echo: survive');
  } finally {
    llm.state.failAll = false;
    await ctx.api('DELETE', `/v1/admin/servers/${add.json.server.id}`, { token: owner.token });
    await llm2.close();
  }
});

test('a run fails cleanly when every model server is down', async () => {
  const servers = (await ctx.api('GET', '/v1/admin/servers', { token: owner.token })).json.servers;
  for (const s of servers) await ctx.api('PATCH', `/v1/admin/servers/${s.id}`, { token: owner.token, body: { enabled: false } });
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'anyone?', stream: true } });
  const fail = r.events.at(-1);
  assert.equal(fail.type, 'run.failed');
  assert.equal(fail.data.error.code, 'no_models');
  assert.equal((await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1].status, 'failed');
  for (const s of servers) await ctx.api('PATCH', `/v1/admin/servers/${s.id}`, { token: owner.token, body: { enabled: true } });
});

test('memory: manual CRUD, injection into the prompt, and automatic extraction', async () => {
  const m = await ctx.api('POST', '/v1/memories', { token: owner.token, body: { text: 'Owen lives in Wisconsin' } });
  assert.equal(m.status, 201);
  assert.equal((await ctx.api('GET', '/v1/memories', { token: bob.token })).json.memories.length, 0);
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'what is the weather like', stream: true } });
  const sys = llm.state.requests.filter((q) => q.messages[0].content.includes('You are Hecate')).at(-1).messages[0].content;
  assert.match(sys, /lives in Wisconsin/);
  await waitFor(async () => (await ctx.api('GET', '/v1/memories', { token: owner.token })).json.memories.some((x) => x.source === 'auto'));
  const noMem = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: { use_memory: false } })).json.id;
  await sse(ctx, `/v1/chats/${noMem}/messages`, { token: owner.token, method: 'POST', body: { text: 'private question', stream: true } });
  const sys2 = llm.state.requests.filter((q) => q.messages.at(-1).content === 'private question').at(-1).messages[0].content;
  assert.doesNotMatch(sys2, /Wisconsin/);
  const patched = await ctx.api('PATCH', `/v1/memories/${m.json.id}`, { token: owner.token, body: { text: 'Owen lives in Madison' } });
  assert.equal(patched.json.text, 'Owen lives in Madison');
  assert.equal((await ctx.api('DELETE', `/v1/memories/${m.json.id}`, { token: owner.token })).status, 204);
  assert.equal((await ctx.api('DELETE', '/v1/memories', { token: owner.token })).status, 400);
});

test('chats get a generated title after the first exchange; search and pinning work', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'Explain quantum tunnelling simply', stream: true } });
  assert.equal((await ctx.api('GET', `/v1/chats/${c}`, { token: owner.token })).json.title, 'Explain quantum tunnelling simply');
  await waitFor(async () => (await ctx.api('GET', `/v1/chats/${c}`, { token: owner.token })).json.title === 'Gateway Test Chat');
  const found = await ctx.api('GET', '/v1/search?q=tunnelling', { token: owner.token });
  assert.ok(found.json.messages.some((m) => m.chat_id === c));
  await ctx.api('PATCH', `/v1/chats/${c}`, { token: owner.token, body: { pinned: true, title: 'Pinned one' } });
  const list = (await ctx.api('GET', '/v1/chats', { token: owner.token })).json.chats;
  assert.equal(list[0].id, c);
  assert.equal(list[0].pinned, true);
  assert.equal((await ctx.api('DELETE', `/v1/chats/${c}`, { token: owner.token })).status, 204);
  assert.equal((await ctx.api('GET', `/v1/chats/${c}`, { token: owner.token })).status, 404);
});

test('OpenAI-compatible passthrough works with a service key', async () => {
  assert.equal((await ctx.api('POST', '/openai/v1/chat/completions', { token: bob.token, body: { messages: [{ role: 'user', content: 'x' }] } })).status, 403);
  const key = (await ctx.api('POST', '/v1/admin/api-keys', { token: owner.token, body: { name: 'hermes' } })).json.key;
  assert.match(key, /^hk_/);
  const models = await ctx.api('GET', '/openai/v1/models', { token: key });
  assert.ok(models.json.data.some((m) => m.id === 'hecate-smart'));
  const res = await fetch(ctx.base + '/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'hecate-smart', stream: true, messages: [{ role: 'user', content: 'through the gateway' }] }) });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /Echo: /);
  assert.match(text, /\[DONE\]/);
  assert.equal(llm.state.requests.at(-1).model, 'gpt-oss-20b', 'smart alias resolved to the smart-tier model');
  const emb = await ctx.api('POST', '/openai/v1/embeddings', { token: key, body: { model: 'x', input: ['hello'] } });
  assert.equal(emb.json.data[0].embedding.length, 16);
});

test('admin can disable a user, which revokes access immediately', async () => {
  const inv = await ctx.api('POST', '/v1/admin/invites', { token: owner.token, body: {} });
  const dan = await login(ctx, 'dan', inv.json.code);
  assert.equal((await ctx.api('PATCH', `/v1/admin/users/${dan.user.id}`, { token: owner.token, body: { disabled: true } })).status, 200);
  assert.equal((await ctx.api('GET', '/v1/me', { token: dan.token })).status, 401);
  assert.equal((await ctx.api('POST', '/v1/auth/dev', { body: { name: 'dan' } })).status, 403);
});

test('deleting an account removes the data', async () => {
  const inv = await ctx.api('POST', '/v1/admin/invites', { token: owner.token, body: {} });
  const eve = await login(ctx, 'eve', inv.json.code);
  const c = (await ctx.api('POST', '/v1/chats', { token: eve.token, body: {} })).json.id;
  await sse(ctx, `/v1/chats/${c}/messages`, { token: eve.token, method: 'POST', body: { text: 'bye', stream: true } });
  assert.equal((await ctx.api('DELETE', '/v1/me', { token: eve.token })).status, 204);
  assert.equal(ctx.gw.db.get('SELECT COUNT(*) AS c FROM chats WHERE user_id = ?', eve.user.id).c, 0);
  assert.equal(ctx.gw.db.get('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?', eve.user.id).c, 0);
});

test('disclaimer is a separate field, on by default, and each user can turn it off', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'hi', stream: true } });
  const done = r.events.find((e) => e.type === 'message.completed').data.message;
  assert.match(done.disclaimer, /local assistant powered by AI/);
  assert.ok(!done.text.includes('Keep in mind'), 'not part of the text');
  const me = await ctx.api('GET', '/v1/me', { token: owner.token });
  assert.equal(me.json.show_disclaimer, true);
  const bad = await ctx.api('PATCH', '/v1/me', { token: owner.token, body: { show_disclaimer: 'no' } });
  assert.equal(bad.status, 400);
  const off = await ctx.api('PATCH', '/v1/me', { token: owner.token, body: { show_disclaimer: false } });
  assert.equal(off.json.show_disclaimer, false);
  const msgs = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.equal(msgs[1].disclaimer, null);
  assert.equal(msgs[0].disclaimer, null, 'user messages never carry it');
  await ctx.api('PATCH', '/v1/me', { token: owner.token, body: { show_disclaimer: true } });
  const again = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.ok(again[1].disclaimer);
  const upstream = llm.state.requests.filter((q) => q.model === 'gemma-4-e4b-it' || q.model === 'gpt-oss-20b').at(-1).messages;
  assert.ok(!JSON.stringify(upstream).includes('Keep in mind'), 'never sent to the model');
});

test('model picks are readable by everyone and settable by admins only', async () => {
  const list = (await ctx.api('GET', '/v1/models', { token: bob.token })).json;
  const target = list.models[0];
  assert.ok('picks' in list);
  assert.equal((await ctx.api('PUT', '/v1/admin/model-picks', { token: bob.token, body: { fast: target.id } })).status, 403);
  assert.equal((await ctx.api('PUT', '/v1/admin/model-picks', { token: owner.token, body: { fast: 'nope' } })).status, 400);
  const ok = await ctx.api('PUT', '/v1/admin/model-picks', { token: owner.token, body: { fast: target.id } });
  assert.equal(ok.json.fast, target.id);
  assert.equal((await ctx.api('GET', '/v1/models', { token: bob.token })).json.picks.fast, target.id);
  const cleared = await ctx.api('PUT', '/v1/admin/model-picks', { token: owner.token, body: { fast: null } });
  assert.equal(cleared.json.fast, null);
});
