import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, login, sse, types, startFakeLLM, startFakeDrawThings } from './helpers.js';

let ctx, llm, dt, owner;

before(async () => {
  dt = await startFakeDrawThings();
  llm = await startFakeLLM({ models: ['gemma-4-e4b-it'] });
  ctx = await boot();
  owner = await login(ctx, 'owen');
  await ctx.api('POST', '/v1/admin/servers', { token: owner.token, body: { name: 'fake', base_url: llm.url, default_tier: 'fast' } });
  await new Promise((r) => setTimeout(r, 1200));
});
after(async () => { await ctx.close(); await llm.close(); await dt.close(); });

test('image generation starts off and needs an address that answers', async () => {
  const st = await ctx.api('GET', '/v1/admin/image', { token: owner.token });
  assert.equal(st.json.enabled, false);
  assert.equal((await ctx.api('PUT', '/v1/admin/image', { token: owner.token, body: { enabled: true } })).status, 400);
  const bad = await ctx.api('PUT', '/v1/admin/image', { token: owner.token, body: { url: 'http://127.0.0.1:1' } });
  assert.equal(bad.status, 502);
  assert.equal(bad.json.error.code, 'image_unreachable');
  const ok = await ctx.api('PUT', '/v1/admin/image', { token: owner.token, body: { url: dt.url + '/', enabled: true, width: 768, height: 512, steps: 8, negative_prompt: 'blurry', style: 'bright, well lit' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.url, dt.url);
  assert.equal(ok.json.width, 768);
  assert.ok((await ctx.api('GET', '/v1/capabilities')).json.features.includes('image_generation'));
  assert.equal((await ctx.api('PUT', '/v1/admin/image', { token: owner.token, body: { width: 10 } })).status, 400);
});

test('the model can draw: the picture is saved on the reply', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'DRAWME a car', stream: true } });
  const t = types(r.events);
  assert.ok(t.includes('tool.started') && t.includes('tool.completed'), `events: ${t.join(',')}`);
  assert.equal(r.events.at(-1).type, 'run.completed');
  const sent = dt.state.requests.at(-1);
  assert.equal(sent.prompt, 'a red lexus at night, neon, bright, well lit');
  assert.equal(sent.width, 768); assert.equal(sent.height, 512); assert.equal(sent.steps, 8); assert.equal(sent.negative_prompt, 'blurry');
  const msgs = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.equal(msgs[1].text, 'Here you go.');
  assert.equal(msgs[1].attachments.length, 1);
  const a = msgs[1].attachments[0];
  assert.equal(a.kind, 'image'); assert.equal(a.mime, 'image/png');
  const file = await ctx.api('GET', `/v1/attachments/${a.id}/content`, { token: owner.token });
  assert.equal(file.status, 200);
  const list = await ctx.api('GET', '/v1/attachments?type=photo', { token: owner.token });
  assert.ok(list.json.attachments.some((x) => x.id === a.id));
  // the model remembers what it drew on the next turn
  await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'thanks', stream: true } });
  const last = llm.state.requests.filter((b) => b.messages.some((m) => typeof m.content === 'string' && m.content.includes('thanks'))).at(-1);
  assert.match(last.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'), /You drew a picture[\s\S]*red lexus/);
});

test('a failed drawing is explained, and image can be turned off for one message', async () => {
  const c = (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id;
  dt.state.fail = true;
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'DRAWME again', stream: true } });
  assert.ok(types(r.events).includes('tool.failed'));
  assert.equal(r.events.at(-1).type, 'run.completed');
  const msgs = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.equal(msgs[1].text, 'Sorry, the picture failed.');
  assert.equal(msgs[1].attachments.length, 0);
  dt.state.fail = false;
  const n = dt.state.requests.length;
  const off = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'DRAWME no', stream: true, image: false } });
  assert.ok(!types(off.events).includes('tool.started'));
  assert.equal(dt.state.requests.length, n);
});
