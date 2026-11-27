import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, sse, types, startFakeLLM, startFakeBrave } from './helpers.js';

let ctx, llm, brave, owner;

before(async () => {
  brave = await startFakeBrave();
  process.env.HECATE_BRAVE_URL = brave.url;
  llm = await startFakeLLM({ models: ['gemma-4-e4b-it'] });
  ctx = await boot();
  owner = await login(ctx, 'owen');
  const add = await ctx.api('POST', '/v1/admin/servers', { token: owner.token, body: { name: 'fake', base_url: llm.url, default_tier: 'fast' } });
  assert.equal(add.status, 201);
});
after(async () => { delete process.env.HECATE_BRAVE_URL; await ctx.close(); await llm.close(); await brave.close(); });

test('search starts off and needs a valid key', async () => {
  const st = await ctx.api('GET', '/v1/admin/search', { token: owner.token });
  assert.equal(st.json.enabled, false);
  assert.equal(st.json.key_set, false);
  assert.equal((await ctx.api('PUT', '/v1/admin/search', { token: owner.token, body: { enabled: true } })).status, 400);
  const bad = await ctx.api('PUT', '/v1/admin/search', { token: owner.token, body: { api_key: 'wrong' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'search_key_invalid');
  assert.equal((await ctx.api('GET', '/v1/admin/search', { token: owner.token })).json.key_set, false);
  const bob = await login(ctx, 'owen');
  assert.ok(bob.token);
});

test('a good key is tested, saved, and never returned', async () => {
  const r = await ctx.api('PUT', '/v1/admin/search', { token: owner.token, body: { api_key: 'good-key', enabled: true, results: 7, max_per_reply: 2, monthly_cap: 50 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.key_set, true);
  assert.equal(r.json.results, 7);
  assert.equal(r.json.used_this_month, 1, 'the key test counts as one request');
  assert.ok(!JSON.stringify(r.json).includes('good-key'));
  assert.ok(!JSON.stringify((await ctx.api('GET', '/v1/admin/settings', { token: owner.token })).json).includes('good-key'));
  assert.ok((await ctx.api('GET', '/v1/capabilities')).json.features.includes('web_search'));
  assert.equal((await ctx.api('PUT', '/v1/admin/search', { token: owner.token, body: { results: 99 } })).status, 400);
});

test('the model can search and answers from the results', async () => {
  await new Promise((r) => setTimeout(r, 1200)); // let the model server be discovered
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const before = brave.state.requests.length;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'SEARCHME please', stream: true } });
  const t = types(r.events);
  assert.ok(t.includes('tool.started') && t.includes('tool.completed'), `events: ${t.join(',')}`);
  assert.equal(r.events.at(-1).type, 'run.completed');
  assert.equal(brave.state.requests.length, before + 1);
  const hit = brave.state.requests.at(-1);
  assert.equal(hit.q, 'hecate gateway');
  assert.equal(hit.count, '7');
  const msgs = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.match(msgs[1].text, /From search: \[1\] Hecate Gateway/);
  assert.deepEqual(msgs[1].usage.searches, ['hecate gateway']);
  const sentTools = llm.state.requests.filter((b) => b.tools);
  assert.ok(sentTools.length >= 1);
  assert.ok(sentTools[0].messages[0].content.includes('web_search'));
});

test('later turns still see the search results an earlier answer was based on', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'SEARCHME first', stream: true } });
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'nice, thanks', stream: true } });
  const last = llm.state.requests.filter((b) => b.messages.some((m) => typeof m.content === 'string' && m.content.includes('nice, thanks'))).at(-1);
  const history = last.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  assert.match(history, /Web results this reply was based on/);
  assert.match(history, /Hecate Gateway/);
});

test('search can be turned off for one message, and by the monthly cap', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const before = brave.state.requests.length;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'SEARCHME again', stream: true, search: false } });
  assert.ok(!types(r.events).includes('tool.started'));
  assert.equal(brave.state.requests.length, before);
  await ctx.api('PUT', '/v1/admin/search', { token: owner.token, body: { monthly_cap: 1 } });
  const caps = await ctx.api('GET', '/v1/capabilities');
  assert.ok(!caps.json.features.includes('web_search'), 'the cap switches search off');
});
