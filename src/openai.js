import { Readable } from 'node:stream';
import { err, log, truncate } from './util.js';

/**
 * OpenAI-compatible passthrough so agent harnesses (Hermes) and other tools can use the same
 * model registry, tiers and fallbacks as the apps. Authenticate with a service key (hk_...) or an admin token.
 * Model names: "hecate-fast", "hecate-smart", or a model id from GET /v1/admin/models.
 */
export function registerOpenAI(r, app) {
  const { registry, db } = app;
  const S = { auth: 'service' };

  r.get('/openai/v1/models', () => ({
    object: 'list',
    data: [
      { id: 'hecate-fast', object: 'model', owned_by: 'hecate' }, { id: 'hecate-smart', object: 'model', owned_by: 'hecate' },
      ...registry.listPublicModels().map((m) => ({ id: m.id, object: 'model', owned_by: m.server_name, name: m.display_name, tier: m.tier, capabilities: m.capabilities })),
    ],
  }), S);

  async function forward(c, candidates, path, body) {
    let lastErr = null;
    const ac = new AbortController();
    c.req.on('close', () => { if (!c.res.writableEnded) ac.abort(); });
    for (const cand of candidates.slice(0, 3)) {
      try {
        const res = await fetch(`${cand.base_url}/v1/${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: c.req.headers.accept ?? '*/*', ...cand.headers },
          body: JSON.stringify({ ...body, model: cand.upstream_id }), signal: ac.signal,
        });
        if (res.status >= 500 || res.status === 404) { lastErr = new Error(`${cand.name}: HTTP ${res.status}`); log.warn(`openai passthrough: ${lastErr.message}, trying next model`); continue; }
        c.res.writeHead(res.status, { 'Content-Type': res.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        if (!res.body) return c.res.end();
        Readable.fromWeb(res.body).on('error', () => c.res.end()).pipe(c.res);
        return;
      } catch (e) {
        if (ac.signal.aborted) return;
        lastErr = e;
      }
    }
    throw err(502, 'upstream_unavailable', `No model server could answer: ${truncate(lastErr?.cause?.message ?? lastErr?.message ?? 'none available', 200)}`);
  }

  r.post('/openai/v1/chat/completions', async (c) => {
    const b = c.body;
    if (!Array.isArray(b.messages)) throw err(400, 'invalid_request', 'messages is required');
    const hasImage = JSON.stringify(b.messages).includes('"image_url"');
    const resolved = registry.resolveName(b.model);
    const picks = registry.pick({ ...resolved, needs: { vision: hasImage } });
    if (!picks.length) throw err(503, 'no_models', 'No model server is available');
    await forward(c, picks.map((p) => ({ base_url: p.server.base_url, headers: p.server.headers, upstream_id: p.model.upstream_id, name: p.model.display_name })), 'chat/completions', b);
  }, S);

  r.post('/openai/v1/embeddings', async (c) => {
    const t = registry.embeddingTarget();
    if (!t) throw err(503, 'no_embedding_model', 'No embedding model is available on any server');
    await forward(c, [{ base_url: t.baseUrl, headers: t.headers, upstream_id: t.model, name: 'embeddings' }], 'embeddings', c.body);
  }, S);
}
