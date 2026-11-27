import { err, parseJson, log } from './util.js';
import { sseRequest, UpstreamError, CancelledError } from './llm.js';

/**
 * Adapter for the Hermes Agent API server. Everything Hermes-specific lives here so another
 * agent harness can be swapped in later by implementing the same methods.
 *
 * Modes (admin setting "hermes_mode"):
 *  - "completions" (default, verified): POST {profile}/v1/chat/completions, gateway sends full history.
 *  - "sessions" (UNVERIFIED request body): POST {profile}/api/sessions/{id}/chat/stream, Hermes keeps history.
 */
export class Hermes {
  constructor({ db, settings, secrets }) { this.db = db; this.settings = settings; this.secrets = secrets; }

  isConfigured() { return Boolean(this.settings.get('hermes_url')); }
  baseFor(agent) {
    const url = String(this.settings.get('hermes_url') ?? '').replace(/\/+$/, '');
    if (!url) throw err(503, 'hermes_not_configured', 'Hermes is not attached to this gateway yet (admin: POST /v1/admin/hermes).');
    // "default" means Hermes's main profile, which lives at the plain address.
    return agent?.hermes_profile && agent.hermes_profile !== 'default' ? `${url}/p/${encodeURIComponent(agent.hermes_profile)}` : url;
  }
  headersFor(agent) {
    const key = this.secrets.unseal(agent?.hermes_api_key_enc) ?? this.secrets.unseal(this.settings.get('hermes_key_enc'));
    return key ? { Authorization: `Bearer ${key}` } : {};
  }
  attach({ url, api_key, mode }) {
    let u = String(url ?? '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
    this.settings.set('hermes_url', u);
    if (api_key !== undefined) this.settings.set('hermes_key_enc', this.secrets.seal(api_key) ?? '');
    if (mode) this.settings.set('hermes_mode', mode);
  }
  async status(agent = null) {
    if (!this.isConfigured()) return { attached: false };
    const base = { attached: true, url: this.settings.get('hermes_url'), mode: this.settings.get('hermes_mode') };
    let last = null;
    // Hermes answers /health without a key; /v1/capabilities needs one. Either proves the server is up.
    for (const path of ['/health', '/v1/capabilities']) {
      try {
        const res = await fetch(`${this.baseFor(agent)}${path}`, { headers: this.headersFor(agent), signal: AbortSignal.timeout(5000) });
        if (res.ok) { const capabilities = path === '/v1/capabilities' ? await res.json().catch(() => null) : null; return { ...base, reachable: true, http_status: res.status, capabilities }; }
        last = { http_status: res.status, error: res.status === 401 || res.status === 403 ? 'Hermes rejected the API key (check API_SERVER_KEY)' : `Hermes answered HTTP ${res.status} on ${path}` };
        if (res.status === 401 || res.status === 403) break;
      } catch (e) {
        last = { error: `Could not connect: ${e.cause?.code ?? ''} ${e.cause?.message ?? e.message}`.replace(/\s+/g, ' ').trim() };
        if (e.name === 'TimeoutError') last.error = 'Timed out. Is the address right, and is the firewall letting this computer reach it?';
        break;
      }
    }
    return { ...base, reachable: false, ...last };
  }

  /** Maps one Hermes SSE event to normalized items. */
  #map(name, d) {
    name = String(name).replace(/^hermes\./, '');
    const out = [];
    const runId = d?.run_id;
    if (runId && typeof runId === 'string') out.push({ type: 'hermes_run', id: runId });
    switch (name) {
      case 'assistant.delta': if (d.delta) out.push({ type: 'content', text: d.delta }); break;
      case 'tool.progress':
        if (d.tool_name === '_thinking') { const t = d.delta ?? d.text ?? d.preview; if (t) out.push({ type: 'reasoning', text: t }); }
        else out.push({ type: 'event', name: 'tool.progress', data: { tool_name: d.tool_name, preview: d.preview, args: d.args } });
        break;
      case 'tool.started': case 'tool.completed': case 'tool.failed':
        out.push({ type: 'event', name, data: { tool_name: d.tool_name, preview: d.preview, args: d.args } }); break;
      case 'assistant.commentary': out.push({ type: 'event', name, data: { text: d.text ?? d.content ?? d.delta } }); break;
      case 'approval.request': out.push({ type: 'approval', data: d }); break;
      case 'assistant.completed': out.push({ type: 'final', content: d.content ?? '', usage: d.usage }); break;
      case 'run.failed': out.push({ type: 'failed', error: d.error?.message ?? d.error ?? d.message ?? 'Hermes run failed' }); break;
      case 'run.cancelled': out.push({ type: 'cancelled' }); break;
      default: break; // run.queued, run.started, run.completed, done: nothing to forward
    }
    return out;
  }

  async *stream({ agent, chat, messages, text, signal, firstTokenTimeoutMs, idleTimeoutMs }) {
    const base = this.baseFor(agent);
    const headers = this.headersFor(agent);
    const mode = this.settings.get('hermes_mode') || 'completions';
    let url, body;
    if (mode === 'sessions') {
      const sid = chat.hermes_session_id;
      const mk = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ id: sid }), signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (mk && !mk.ok && mk.status !== 409) log.warn(`Hermes session create returned HTTP ${mk.status}`);
      url = `${base}/api/sessions/${encodeURIComponent(sid)}/chat/stream`;
      body = { message: text }; // UNVERIFIED request shape
    } else {
      url = `${base}/v1/chat/completions`;
      body = { model: 'hermes-agent', messages, stream: true };
    }
    try {
      for await (const ev of sseRequest(url, { headers, body, signal, firstTokenTimeoutMs, idleTimeoutMs })) {
        if (ev.data === '[DONE]') break;
        const d = parseJson(ev.data, null);
        if (!d) continue;
        if (ev.event === 'message' && d.choices) {
          const delta = d.choices[0]?.delta ?? {};
          const rs = delta.reasoning_content ?? delta.reasoning;
          if (rs) yield { type: 'reasoning', text: rs };
          if (delta.content) yield { type: 'content', text: delta.content };
          if (d.usage) yield { type: 'usage', usage: d.usage };
          continue;
        }
        const name = ev.event !== 'message' ? ev.event : d.event ?? d.type ?? '';
        for (const item of this.#map(name, d)) yield item;
      }
    } catch (e) {
      if (e instanceof UpstreamError && e.status === 404 && agent?.hermes_profile) {
        throw err(502, 'hermes_profile_missing', `Hermes has no profile "${agent.hermes_profile}". Create it in Hermes first (or change the agent's hermes_profile).`);
      }
      throw e;
    }
  }

  async approve(agent, hermesRunId, { request_id, execution_generation, choice }) {
    const res = await fetch(`${this.baseFor(agent)}/v1/runs/${encodeURIComponent(hermesRunId)}/approval`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...this.headersFor(agent) },
      body: JSON.stringify({ request_id, execution_generation, choice }), signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw err(502, 'hermes_error', `Hermes rejected the approval (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  async stop(agent, hermesRunId) {
    await fetch(`${this.baseFor(agent)}/v1/runs/${encodeURIComponent(hermesRunId)}/stop`, {
      method: 'POST', headers: this.headersFor(agent), signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}
export { CancelledError };
