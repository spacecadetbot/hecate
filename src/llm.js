// Streaming client for OpenAI-compatible servers (LM Studio, Ollama, llama.cpp, ...).

export class UpstreamError extends Error {
  constructor(status, body, opts = {}) {
    super(`upstream ${status}: ${String(body).slice(0, 300)}`);
    this.status = status; this.body = body;
    this.network = Boolean(opts.network);
    this.retryable = opts.retryable ?? (status >= 500 || status === 429);
  }
}
export class CancelledError extends Error { constructor() { super('cancelled'); this.cancelled = true; } }

function parseEvent(raw) {
  let event = 'message'; const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const val = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = val; else if (field === 'data') data.push(val);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

export async function* readSSE(body) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf))) {
      const ev = parseEvent(buf.slice(0, m.index));
      buf = buf.slice(m.index + m[0].length);
      if (ev) yield ev;
    }
  }
  buf += dec.decode();
  if (buf.trim()) { const ev = parseEvent(buf); if (ev) yield ev; }
}

/** POST/GET an SSE endpoint with first-token and idle timeouts and caller cancellation. */
export async function* sseRequest(url, { method = 'POST', headers = {}, body, signal, firstTokenTimeoutMs = 180000, idleTimeoutMs = 90000 }) {
  if (signal?.aborted) throw new CancelledError();
  const ac = new AbortController();
  let timedOut = null;
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let timer;
  const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => { timedOut = why; ac.abort(); }, ms); };
  arm(firstTokenTimeoutMs, 'no response from the model server (first-token timeout)');
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) throw new UpstreamError(res.status, await res.text().catch(() => ''));
    for await (const ev of readSSE(res.body)) {
      arm(idleTimeoutMs, 'model server stopped streaming (idle timeout)');
      yield ev;
    }
  } catch (e) {
    if (e instanceof UpstreamError) throw e;
    if (signal?.aborted) throw new CancelledError();
    if (timedOut) throw new UpstreamError(504, timedOut, { retryable: true });
    throw new UpstreamError(502, e?.cause?.message ?? e.message, { retryable: true, network: true });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    ac.abort();
  }
}

/** Splits <think>...</think> out of plain content for servers that do not separate reasoning. */
class ThinkSplitter {
  constructor() { this.buf = ''; this.inThink = false; }
  push(text) {
    this.buf += text;
    const out = [];
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>';
      const i = this.buf.indexOf(tag);
      if (i !== -1) {
        const before = this.buf.slice(0, i);
        if (before) out.push({ type: this.inThink ? 'reasoning' : 'content', text: before });
        this.buf = this.buf.slice(i + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      let hold = 0;
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) { hold = k; break; }
      }
      const emit = this.buf.slice(0, this.buf.length - hold);
      if (emit) out.push({ type: this.inThink ? 'reasoning' : 'content', text: emit });
      this.buf = this.buf.slice(this.buf.length - hold);
      return out;
    }
  }
  flush() {
    const out = this.buf ? [{ type: this.inThink ? 'reasoning' : 'content', text: this.buf }] : [];
    this.buf = '';
    return out;
  }
}

/** Yields {type:'content'|'reasoning', text} | {type:'usage', usage} | {type:'finish', reason} | {type:'tool_calls', calls:[{id,name,arguments}]}. */
export async function* streamChat({ baseUrl, headers, body, signal, firstTokenTimeoutMs, idleTimeoutMs }) {
  const split = new ThinkSplitter();
  let sawReasoningField = false;
  let sawContent = false;
  const calls = {};   // tool calls arrive in pieces, keyed by index
  const gen = sseRequest(`${baseUrl}/v1/chat/completions`, {
    headers, signal, firstTokenTimeoutMs, idleTimeoutMs,
    body: { ...body, stream: true, stream_options: { include_usage: true } },
  });
  for await (const ev of gen) {
    if (ev.data === '[DONE]') break;
    let j;
    try { j = JSON.parse(ev.data); } catch { continue; }
    if (j.error) throw new UpstreamError(502, typeof j.error === 'string' ? j.error : JSON.stringify(j.error));
    const ch = j.choices?.[0];
    const d = ch?.delta ?? {};
    const rs = d.reasoning_content ?? d.reasoning;
    if (rs) { sawReasoningField = true; yield { type: 'reasoning', text: rs }; }
    if (d.content) {
      if (sawReasoningField) { sawContent = true; yield { type: 'content', text: d.content }; }
      else for (const piece of split.push(d.content)) { if (piece.type === 'content') sawContent = true; yield piece; }
    }
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const cur = (calls[t.index ?? 0] ??= { id: '', name: '', arguments: '' });
        if (t.id) cur.id = t.id;
        if (t.function?.name) cur.name += t.function.name;
        if (t.function?.arguments) cur.arguments += t.function.arguments;
      }
    }
    if (j.usage) yield { type: 'usage', usage: j.usage };
    if (ch?.finish_reason) yield { type: 'finish', reason: ch.finish_reason };
  }
  for (const piece of split.flush()) { if (piece.type === 'content') sawContent = true; yield piece; }
  void sawContent;
  const done = Object.values(calls).filter((c) => c.name);
  if (done.length) yield { type: 'tool_calls', calls: done };
}

/** Convenience for background jobs: run a chat to completion and return the text. */
export async function chatOnce(opts) {
  let text = '';
  for await (const p of streamChat(opts)) if (p.type === 'content') text += p.text;
  return text.trim();
}

export async function embed({ baseUrl, headers, model, input, signal }) {
  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model, input }), signal: signal ?? AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new UpstreamError(res.status, await res.text().catch(() => ''));
  const j = await res.json();
  return (j.data ?? []).sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
}
