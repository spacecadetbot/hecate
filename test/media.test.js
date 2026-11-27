import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, login, sse, types, startFakeLLM, waitFor } from './helpers.js';

let ctx, llm, owner;
const hasFfmpeg = spawnSync('sh', ['-c', 'command -v ffmpeg']).status === 0;
const hasZip = spawnSync('sh', ['-c', 'command -v zip']).status === 0;
const hasPdf = spawnSync('sh', ['-c', 'command -v pdftotext']).status === 0;

// 1x1 red PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function wav() {
  const n = 1600; const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

before(async () => {
  llm = await startFakeLLM({ models: ['gemma-4-e4b-it', 'plain-text-model'] });
  ctx = await boot();
  owner = await login(ctx, 'owen');
  await ctx.api('POST', '/v1/admin/servers', { token: owner.token, body: { name: 'fake', base_url: llm.url } });
});
after(async () => { await ctx.close(); await llm.close(); });

const upload = (name, buf, mime) => ctx.api('POST', `/v1/attachments?filename=${encodeURIComponent(name)}`, { token: owner.token, raw: buf, headers: { 'Content-Type': mime } });
async function chat() { return (await ctx.api('POST', '/v1/chats', { token: owner.token, body: {} })).json.id; }
// Background jobs (titles, memory extraction) also hit the model, so look only at requests carrying content parts.
const lastUserParts = () => llm.state.requests.filter((q) => q.model === 'gemma-4-e4b-it' && Array.isArray(q.messages.at(-1).content)).at(-1).messages.at(-1).content;

test('upload, metadata, ranged download, isolation, delete', async () => {
  const up = await upload('hello.txt', Buffer.from('0123456789'), 'text/plain');
  assert.equal(up.status, 201);
  assert.equal(up.json.kind, 'text');
  assert.equal(up.json.size, 10);
  const r = await fetch(`${ctx.base}/v1/attachments/${up.json.id}/content`, { headers: { Authorization: `Bearer ${owner.token}`, Range: 'bytes=2-4' } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), '234');
  const inv = (await ctx.api('POST', '/v1/admin/invites', { token: owner.token, body: {} })).json.code;
  const other = await login(ctx, 'other', inv);
  assert.equal((await ctx.api('GET', `/v1/attachments/${up.json.id}`, { token: other.token })).status, 404);
  assert.equal((await upload('empty.txt', Buffer.alloc(0), 'text/plain')).status, 400);
  assert.equal((await ctx.api('DELETE', `/v1/attachments/${up.json.id}`, { token: owner.token })).status, 204);
  assert.equal((await ctx.api('GET', `/v1/attachments/${up.json.id}`, { token: owner.token })).status, 404);
});

test('upload limit is enforced while streaming', async () => {
  const small = await boot({ maxUploadBytes: 1000 });
  try {
    const o = await login(small, 'x');
    const r = await small.api('POST', '/v1/attachments?filename=big.bin', { token: o.token, raw: Buffer.alloc(5000, 1), headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 413);
  } finally { await small.close(); }
});

test('text files are inlined into the prompt and linked to the message', async () => {
  const c = await chat();
  const up = await upload('notes.md', Buffer.from('# Plan\nBuy milk'), 'text/markdown');
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'summarise', attachment_ids: [up.json.id], stream: true } });
  assert.equal(r.events.at(-1).type, 'run.completed');
  const parts = lastUserParts();
  assert.ok(parts.some((p) => p.type === 'text' && p.text.includes('Buy milk')));
  const msgs = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages;
  assert.equal(msgs[0].attachments[0].filename, 'notes.md');
  const again = await ctx.api('POST', `/v1/chats/${c}/messages`, { token: owner.token, body: { text: 'reuse', attachment_ids: [up.json.id] } });
  assert.equal(again.status, 400, 'an attachment can only be sent once');
});

test('images go to vision-capable models as image_url parts', async () => {
  const c = await chat();
  const up = await upload('dot.png', PNG, 'image/png');
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'what is this', attachment_ids: [up.json.id], stream: true } });
  assert.equal(r.events.find((e) => e.type === 'model.selected').data.name, 'gemma-4-e4b-it', 'router prefers the vision model');
  const img = lastUserParts().find((p) => p.type === 'image_url');
  assert.match(img.image_url.url, /^data:image\/png;base64,/);
  const m = (await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1];
  assert.equal(m.text, 'Saw 1 image(s).');
});

test('audio is sent natively to audio-capable models', async () => {
  const c = await chat();
  const up = await upload('memo.wav', wav(), 'audio/wav');
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'transcribe', attachment_ids: [up.json.id], stream: true } });
  const part = lastUserParts().find((p) => p.type === 'input_audio');
  assert.equal(part.input_audio.format, 'wav');
  assert.ok(part.input_audio.data.length > 100);
  assert.ok(types(r.events).includes('attachment.processing'));
  assert.equal((await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1].text, 'Heard audio.');
});

test('audio falls back to speech-to-text for models without audio input', async () => {
  await ctx.api('PATCH', '/v1/admin/settings', { token: owner.token, body: { stt_url: llm.url } });
  const gemma = (await ctx.api('GET', '/v1/admin/models', { token: owner.token })).json.models.find((m) => m.upstream_id === 'gemma-4-e4b-it');
  await ctx.api('PATCH', `/v1/admin/models/${gemma.id}`, { token: owner.token, body: { enabled: false } });
  try {
    const c = await chat();
    const up = await upload('memo.wav', wav(), 'audio/wav');
    await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'what was said', attachment_ids: [up.json.id], stream: true } });
    const parts = llm.state.requests.filter((q) => q.model === 'plain-text-model').at(-1).messages.at(-1).content;
    assert.ok(parts.some((p) => p.type === 'text' && p.text.includes('hello from the recording')));
    assert.equal(llm.state.transcriptions >= 1, true);
  } finally { await ctx.api('PATCH', `/v1/admin/models/${gemma.id}`, { token: owner.token, body: { enabled: true } }); }
});

test('video: native first; if the server rejects it, retry with frames', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hecate-vid-'));
  const file = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=3', '-pix_fmt', 'yuv420p', file]);
  const buf = fs.readFileSync(file);
  const c = await chat();
  const up = await upload('clip.mp4', buf, 'video/mp4');
  assert.equal(up.json.kind, 'video');
  await waitFor(async () => (await ctx.api('GET', `/v1/attachments/${up.json.id}`, { token: owner.token })).json.has_thumbnail);
  let r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'describe', attachment_ids: [up.json.id], stream: true } });
  assert.ok(lastUserParts().some((p) => p.type === 'video_url'));
  assert.equal((await ctx.api('GET', `/v1/chats/${c}/messages`, { token: owner.token })).json.messages[1].text, 'Saw native video.');

  llm.state.rejectVideo = true;
  try {
    const c2 = await chat();
    const up2 = await upload('clip.mp4', buf, 'video/mp4');
    r = await sse(ctx, `/v1/chats/${c2}/messages`, { token: owner.token, method: 'POST', body: { text: 'describe', attachment_ids: [up2.json.id], stream: true } });
    assert.equal(r.events.at(-1).type, 'run.completed');
    assert.ok(r.events.some((e) => e.type === 'attachment.processing' && e.data.status === 'fallback'));
    assert.ok(lastUserParts().filter((p) => p.type === 'image_url').length >= 1, 'frames were sampled and sent as images');
    assert.match((await ctx.api('GET', `/v1/chats/${c2}/messages`, { token: owner.token })).json.messages[1].text, /image/);
  } finally { llm.state.rejectVideo = false; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pdf and docx text extraction', { skip: !(hasPdf && hasZip) && 'pdftotext/zip not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hecate-doc-'));
  try {
    // minimal docx
    fs.mkdirSync(path.join(dir, 'word'), { recursive: true });
    fs.writeFileSync(path.join(dir, '[Content_Types].xml'), '<Types/>');
    fs.writeFileSync(path.join(dir, 'word/document.xml'), '<w:document><w:body><w:p><w:r><w:t>Quarterly budget &amp; plan</w:t></w:r></w:p></w:body></w:document>');
    execFileSync('zip', ['-q', '-r', path.join(dir, 'doc.docx'), '[Content_Types].xml', 'word'], { cwd: dir });
    const c = await chat();
    const up = await upload('doc.docx', fs.readFileSync(path.join(dir, 'doc.docx')), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(up.json.kind, 'document');
    await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'read it', attachment_ids: [up.json.id], stream: true } });
    assert.ok(lastUserParts().some((p) => p.type === 'text' && p.text.includes('Quarterly budget & plan')));
    assert.equal((await ctx.api('GET', `/v1/attachments/${up.json.id}`, { token: owner.token })).json.has_extracted_text, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an attachment that cannot be processed degrades to a note, not a failed run', async () => {
  const c = await chat();
  const up = await upload('blob.bin', Buffer.from([1, 2, 3, 4]), 'application/octet-stream');
  const r = await sse(ctx, `/v1/chats/${c}/messages`, { token: owner.token, method: 'POST', body: { text: 'look', attachment_ids: [up.json.id], stream: true } });
  assert.equal(r.events.at(-1).type, 'run.completed');
  assert.ok(r.events.some((e) => e.type === 'attachment.processing' && e.data.status === 'failed'));
});
