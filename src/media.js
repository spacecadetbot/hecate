import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { err, newId, now, iso, parseJson, log, truncate } from './util.js';

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 128 * 1024 * 1024, timeout: 180000, encoding: 'utf8', ...opts }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr })) : resolve(stdout)));
});

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', caf: 'audio/x-caf',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', mkv: 'video/x-matroska',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
};
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'swift', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'sql', 'log', 'ini', 'conf', 'env', 'tex']);
const NATIVE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function classify(mime, filename) {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (['pdf', 'docx', 'pptx', 'xlsx'].includes(ext) || mime === 'application/pdf' || mime.includes('officedocument')) return 'document';
  if (mime.startsWith('text/') || TEXT_EXT.has(ext) || mime === 'application/json') return 'text';
  return 'file';
}
const xmlText = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export class Media {
  constructor({ db, config, settings }) { this.db = db; this.config = config; this.settings = settings; }

  publicAttachment(a) {
    return {
      id: a.id, kind: a.kind, filename: a.filename, mime: a.mime, size: a.size, status: a.status, message_id: a.message_id,
      has_thumbnail: Boolean(a.thumb_path), has_extracted_text: Boolean(a.extracted_text), created_at: iso(a.created_at),
    };
  }
  get(id, userId) {
    const a = this.db.get('SELECT * FROM attachments WHERE id = ?', id);
    if (!a || a.user_id !== userId) throw err(404, 'not_found', 'Attachment not found');
    return a;
  }

  // ---------- upload ----------
  async save(req, user, { filename, mime }) {
    const max = this.config.maxUploadBytes;
    if (Number(req.headers['content-length'] ?? 0) > max) throw err(413, 'payload_too_large', `Upload exceeds the ${Math.round(max / 1048576)} MB limit`);
    filename = path.basename(String(filename || 'upload')).slice(0, 200) || 'upload';
    const ext = path.extname(filename).slice(1).toLowerCase();
    mime = String(mime || '').split(';')[0].trim().toLowerCase();
    if (!mime || mime === 'application/octet-stream') mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    const id = newId('att');
    const dir = path.join(this.config.dataDir, 'files', user.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, id + (ext ? '.' + ext.replace(/[^a-z0-9]/g, '').slice(0, 8) : ''));
    const hash = crypto.createHash('sha256');
    let size = 0;
    try {
      await pipeline(req, async function* (src) {
        for await (const c of src) {
          size += c.length;
          if (size > max) throw err(413, 'payload_too_large', `Upload exceeds the ${Math.round(max / 1048576)} MB limit`);
          hash.update(c);
          yield c;
        }
      }, fs.createWriteStream(file));
    } catch (e) { fs.rmSync(file, { force: true }); throw e; }
    if (size === 0) { fs.rmSync(file, { force: true }); throw err(400, 'empty_upload', 'The uploaded file is empty'); }
    const kind = classify(mime, filename);
    this.db.run('INSERT INTO attachments(id, user_id, kind, filename, mime, size, sha256, path, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, user.id, kind, filename, mime, size, hash.digest('hex'), file, now());
    this.#thumbnail(id, kind, file).catch(() => {});
    return this.db.get('SELECT * FROM attachments WHERE id = ?', id);
  }
  async #thumbnail(id, kind, file) {
    if (!this.config.ffmpeg || (kind !== 'image' && kind !== 'video')) return;
    const out = file.replace(/\.[^.]*$/, '') + '.thumb.jpg';
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', "scale='min(360,iw)':-2", '-frames:v', '1', out], { timeout: 30000 });
      if (fs.existsSync(out)) this.db.run('UPDATE attachments SET thumb_path = ? WHERE id = ?', out, id);
    } catch { /* thumbnails are optional */ }
  }
  removeFiles(a) {
    for (const p of [a.path, a.thumb_path]) if (p) fs.rmSync(p, { force: true });
  }

  // ---------- document text ----------
  async extractText(a) {
    if (a.extracted_text) return a.extracted_text;
    const ext = path.extname(a.filename).slice(1).toLowerCase();
    let text;
    if (a.kind === 'text') text = fs.readFileSync(a.path, 'utf8');
    else if (ext === 'pdf' || a.mime === 'application/pdf') {
      if (!this.config.pdftotext) throw new Error('PDF text extraction needs "pdftotext" (apt install poppler-utils) on the gateway host');
      text = await run('pdftotext', ['-layout', a.path, '-']);
    } else if (['docx', 'pptx', 'xlsx'].includes(ext)) {
      if (!this.config.unzip) throw new Error('Office documents need "unzip" on the gateway host');
      text = await this.#extractOffice(a.path, ext);
    } else throw new Error(`No text extractor for ${a.mime}`);
    text = text.replace(/\r/g, '').replace(/\n{4,}/g, '\n\n\n').trim();
    if (!text) throw new Error('The document contains no extractable text (is it a scan?)');
    this.db.run('UPDATE attachments SET extracted_text = ? WHERE id = ?', text, a.id);
    a.extracted_text = text;
    return text;
  }
  async #extractOffice(file, ext) {
    const unz = (inner) => run('unzip', ['-p', file, inner]);
    if (ext === 'docx') {
      const xml = await unz('word/document.xml');
      return xmlText(xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<[^>]+>/g, ''));
    }
    if (ext === 'pptx') {
      const names = (await run('unzip', ['-Z1', file])).split('\n').filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((x, y) => parseInt(x.match(/(\d+)\.xml/)[1], 10) - parseInt(y.match(/(\d+)\.xml/)[1], 10));
      const out = [];
      for (const [i, n] of names.entries()) out.push(`--- Slide ${i + 1} ---\n` + xmlText((await unz(n)).replace(/<\/a:p>/g, '\n').replace(/<[^>]+>/g, '')));
      return out.join('\n');
    }
    const strings = [...(await unz('xl/sharedStrings.xml')).matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => xmlText(m[1]));
    return `(Spreadsheet text cells; layout is not preserved)\n${strings.join('\n')}`;
  }
  documentPart(a, text) {
    const max = this.config.maxExtractChars;
    const body = text.length > max ? text.slice(0, max) + `\n[... truncated, ${text.length - max} more characters ...]` : text;
    return { type: 'text', text: `[Attached file: ${a.filename}]\n${body}\n[End of ${a.filename}]` };
  }

  // ---------- speech-to-text (optional external server) ----------
  async transcribe(a, signal) {
    if (a.kind !== 'text' && a.extracted_text) return a.extracted_text;
    const url = this.settings.get('stt_url');
    if (!url) throw new Error('No speech-to-text server configured (admin setting "stt_url")');
    const tmp = await this.#toWav(a.path);
    try {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(tmp ?? a.path)]), tmp ? 'audio.wav' : a.filename);
      form.append('model', this.settings.get('stt_model') || 'whisper-1');
      const res = await fetch(`${String(url).replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: signal ?? AbortSignal.timeout(600000) });
      if (!res.ok) throw new Error(`speech-to-text server returned HTTP ${res.status}`);
      const text = ((await res.json()).text ?? '').trim();
      if (!text) throw new Error('No speech detected');
      this.db.run('UPDATE attachments SET extracted_text = ? WHERE id = ?', text, a.id);
      a.extracted_text = text;
      return text;
    } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
  }
  async #toWav(file) {
    if (!this.config.ffmpeg) return null;
    const out = path.join(os.tmpdir(), `hecate-${crypto.randomBytes(6).toString('hex')}.wav`);
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', out], { timeout: 300000 });
    return out;
  }

  // ---------- per-model preparation ----------
  /**
   * Turns one attachment into OpenAI-style content parts for a specific model.
   * Uses native audio/video/image input when the model supports it, otherwise the fallback pipeline.
   * Returns { parts, native } where native=true means a native media part was used (can be retried without).
   */
  async prepare(a, model, { status = () => {}, signal, forceFallback = false } = {}) {
    const caps = model.capabilities ?? [];
    const note = (t) => ({ type: 'text', text: t });
    status(a, 'started');
    try {
      const r = await this.#prepare(a, model, caps, { status, signal, forceFallback, note });
      status(a, 'done');
      return r;
    } catch (e) {
      log.warn(`attachment ${a.id} (${a.filename}): ${e.message}`);
      status(a, 'failed', e.message);
      return { parts: [note(`[Attachment "${a.filename}" could not be processed: ${e.message}]`)], native: false };
    }
  }
  async #prepare(a, model, caps, { status, signal, forceFallback, note }) {
    if (a.kind === 'image') {
      if (!caps.includes('vision')) return { parts: [note(`[Image "${a.filename}" attached, but the selected model cannot see images]`)], native: false };
      let file = a.path; let mime = a.mime; let tmp = null;
      if ((!NATIVE_IMAGE.has(mime) || a.size > 8 * 1048576) && this.config.ffmpeg) {
        tmp = path.join(os.tmpdir(), `hecate-${crypto.randomBytes(6).toString('hex')}.jpg`);
        await run('ffmpeg', ['-v', 'error', '-y', '-i', a.path, '-vf', "scale='min(2048,iw)':-2", '-q:v', '3', tmp], { timeout: 60000 });
        file = tmp; mime = 'image/jpeg';
      } else if (!NATIVE_IMAGE.has(mime)) throw new Error(`${mime} images are not supported (convert to JPEG/PNG on the device)`);
      try { return { parts: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` } }], native: false }; }
      finally { if (tmp) fs.rmSync(tmp, { force: true }); }
    }
    if (a.kind === 'document' || a.kind === 'text') {
      status(a, 'progress', 'extracting text');
      return { parts: [this.documentPart(a, await this.extractText(a))], native: false };
    }
    if (a.kind === 'audio') {
      if (caps.includes('audio') && !forceFallback) {
        let file = a.path; let fmt = a.mime.includes('mpeg') ? 'mp3' : a.mime.includes('wav') ? 'wav' : null; let tmp = null;
        if (!fmt) { status(a, 'progress', 'converting audio'); tmp = await this.#toWav(a.path); if (!tmp) throw new Error('This audio format needs ffmpeg on the gateway host'); file = tmp; fmt = 'wav'; }
        try { return { parts: [note(`[Audio file: ${a.filename}]`), { type: 'input_audio', input_audio: { data: fs.readFileSync(file).toString('base64'), format: fmt } }], native: true }; }
        finally { if (tmp) fs.rmSync(tmp, { force: true }); }
      }
      status(a, 'progress', 'transcribing');
      return { parts: [note(`[Transcript of audio file "${a.filename}"]\n${await this.transcribe(a, signal)}`)], native: false };
    }
    if (a.kind === 'video') return this.#prepareVideo(a, caps, model, { status, signal, forceFallback, note });
    throw new Error(`Unsupported attachment type (${a.mime})`);
  }
  async #prepareVideo(a, caps, model, { status, signal, forceFallback, note }) {
    if (caps.includes('video') && !forceFallback && a.size <= this.config.nativeVideoMaxBytes) {
      const style = model.options?.video_style ?? 'video_url';
      if (style === 'video_url') {
        return { parts: [note(`[Video file: ${a.filename}]`), { type: 'video_url', video_url: { url: `data:${a.mime};base64,${fs.readFileSync(a.path).toString('base64')}` } }], native: true };
      }
    }
    if (!this.config.ffmpeg) throw new Error('This model cannot take video directly and the gateway host has no ffmpeg to sample frames');
    status(a, 'progress', 'sampling video frames');
    let duration = 0;
    try { duration = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', a.path], { timeout: 20000 })) || 0; } catch { /* unknown length */ }
    const max = this.config.videoMaxFrames;
    const every = Math.max(this.config.videoFrameEverySec, duration ? duration / max : 0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hecate-frames-'));
    const parts = [];
    try {
      await run('ffmpeg', ['-v', 'error', '-i', a.path, '-vf', `fps=1/${every.toFixed(2)},scale='min(768,iw)':-2`, '-frames:v', String(max), '-q:v', '4', path.join(dir, 'f%03d.jpg')], { timeout: 300000 });
      const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
      const canSee = caps.includes('vision');
      parts.push(note(`[Video "${a.filename}"${duration ? `, ${Math.round(duration)}s` : ''}: ${canSee ? `${frames.length} frames sampled about every ${Math.round(every)}s follow` : 'this model cannot see frames'}]`));
      if (canSee) for (const f of frames) parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}` } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    if (this.settings.get('stt_url')) {
      try { status(a, 'progress', 'transcribing audio track'); parts.push(note(`[Audio transcript of "${a.filename}"]\n${await this.transcribe(a, signal)}`)); }
      catch (e) { log.debug('video transcript skipped:', e.message); }
    }
    return { parts, native: false };
  }

  /** Short text stand-in for an attachment in older turns (media is only sent with the current message). */
  historyText(a) {
    let t = `[Attached ${a.kind}: ${a.filename}]`;
    if (a.extracted_text) t += `\n${truncate(a.extracted_text, 12000)}`;
    return t;
  }
}
