// Image generation through Draw Things (https://drawthings.ai). Draw Things runs on the user's Mac with its API server turned on
// (Settings > Advanced > API Server, protocol HTTP, port 7860) and answers Stable-Diffusion-web-UI style requests.
// The model gets a generate_image tool; finished pictures are saved as attachments of the reply.
import { err, log } from './util.js';

export const IMAGE_GUIDE = `

You can draw pictures with the generate_image tool. Use it when the user asks you to show, draw, make, create or send them a picture, photo or image of something. Write the prompt yourself as one detailed, concrete description in English: the subject, setting, lighting, mood, camera or art style, and anything specific the user asked for. Do not ask the user to write the prompt. After the image is made it appears in the chat on its own, so reply with at most a short sentence and never describe a link. If the tool reports a failure, tell the user plainly what went wrong.`;

export const IMAGE_FORCE = `\n\nThe user chose "Generate image" for this message: call generate_image now with a good prompt based on their request.`;

const sniff = (buf) => {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
};

export class Images {
  constructor({ settings, media }) { this.settings = settings; this.media = media; }
  get url() { return String(this.settings.get('image_url') || '').replace(/\/+$/, ''); }
  get available() { return Boolean(this.settings.get('image_enabled') && this.url); }
  status() {
    return {
      provider: 'drawthings',
      enabled: Boolean(this.settings.get('image_enabled')),
      url: this.url,
      width: this.settings.get('image_width'),
      height: this.settings.get('image_height'),
      steps: this.settings.get('image_steps'),
      negative_prompt: this.settings.get('image_negative'),
    };
  }
  tool() {
    return { type: 'function', function: {
      name: 'generate_image',
      description: 'Generate a picture from a text description and show it to the user in the chat.',
      parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'A detailed description of the image: subject, setting, lighting, style' } }, required: ['prompt'] },
    } };
  }
  /** Checks that something answers at the address (any HTTP answer counts; Draw Things may return 404 for the root page). */
  async test(url = this.url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) throw err(400, 'invalid_request', 'The address must start with http:// or https://');
    try { await fetch(`${url}/`, { signal: AbortSignal.timeout(6000) }); }
    catch (e) { throw err(502, 'image_unreachable', `Couldn't reach Draw Things at ${url}. Is the app open with its API server on (HTTP)? ${e.cause?.message ?? e.message}`); }
    return url;
  }
  /** Draws one picture and stores it as an attachment of the reply (messageId). */
  async generate(prompt, { user, messageId, signal }) {
    prompt = String(prompt ?? '').trim().slice(0, 4000);
    if (!prompt) throw err(400, 'invalid_request', 'Empty image prompt');
    if (!this.url) throw err(400, 'image_not_configured', 'Image generation is not set up');
    const body = { prompt, negative_prompt: this.settings.get('image_negative') || '', seed: -1,
      width: this.settings.get('image_width'), height: this.settings.get('image_height') };
    const steps = Number(this.settings.get('image_steps'));
    if (steps > 0) body.steps = steps;
    let res;
    try {
      res = await fetch(`${this.url}/sdapi/v1/txt2img`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw err(502, 'image_unreachable', `Couldn't reach Draw Things (${e.cause?.message ?? e.message}). Is the app open with its API server on?`);
    }
    if (!res.ok) throw err(502, 'image_failed', `Draw Things answered ${res.status}`);
    const j = await res.json().catch(() => null);
    let b64 = j?.images?.[0];
    if (typeof b64 !== 'string' || !b64) throw err(502, 'image_failed', 'Draw Things returned no image');
    if (b64.startsWith('data:')) b64 = b64.slice(b64.indexOf(',') + 1);
    const buf = Buffer.from(b64, 'base64');
    const kind = sniff(buf);
    if (!kind) throw err(502, 'image_failed', 'Draw Things returned something that is not an image');
    const a = this.media.saveBytes(user, buf, { filename: `Generated image ${Date.now().toString(36)}.${kind.ext}`, mime: kind.mime, messageId });
    log.info(`image generated (${buf.length} bytes) for ${user.id}`);
    return a;
  }
}
