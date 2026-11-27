import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(o = {}) {
  if (!o.noDotEnv) loadDotEnv(path.resolve('.env'));
  const env = o.env ?? process.env;
  const dataDir = path.resolve(o.dataDir ?? env.HECATE_DATA_DIR ?? './data');
  fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });

  const keyFile = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const secret = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');

  return {
    name: 'hecate-gateway',
    version: pkg.version,
    apiVersion: 1,
    host: o.host ?? env.HECATE_HOST ?? '0.0.0.0',
    port: o.port ?? num(env.HECATE_PORT, 8080),
    dataDir,
    secret,
    logLevel: o.logLevel ?? env.HECATE_LOG_LEVEL ?? 'info',

    appleBundleId: o.appleBundleId ?? env.HECATE_APPLE_BUNDLE_ID ?? '',
    appleIssuer: o.appleIssuer ?? env.HECATE_APPLE_ISSUER ?? 'https://appleid.apple.com',
    appleJwksUrl: o.appleJwksUrl ?? env.HECATE_APPLE_JWKS_URL ?? 'https://appleid.apple.com/auth/keys',
    devLogin: o.devLogin ?? bool(env.HECATE_DEV_LOGIN, false),
    openSignup: o.openSignup ?? bool(env.HECATE_OPEN_SIGNUP, false),
    accessTtlSec: o.accessTtlSec ?? num(env.HECATE_ACCESS_TTL_SEC, 900),
    refreshTtlDays: o.refreshTtlDays ?? num(env.HECATE_REFRESH_TTL_DAYS, 90),

    maxUploadBytes: o.maxUploadBytes ?? num(env.HECATE_MAX_UPLOAD_MB, 2048) * 1024 * 1024,
    nativeVideoMaxBytes: o.nativeVideoMaxBytes ?? num(env.HECATE_NATIVE_VIDEO_MAX_MB, 96) * 1024 * 1024,
    maxExtractChars: num(env.HECATE_MAX_EXTRACT_CHARS, 200000),
    videoFrameEverySec: num(env.HECATE_VIDEO_FRAME_EVERY_SEC, 4),
    videoMaxFrames: num(env.HECATE_VIDEO_MAX_FRAMES, 16),

    healthIntervalMs: o.healthIntervalMs ?? num(env.HECATE_HEALTH_INTERVAL_MS, 30000),
    // Health checks only run while someone has used the API within this window (0 = always check).
    healthActiveWindowMs: o.healthActiveWindowMs ?? num(env.HECATE_HEALTH_ACTIVE_WINDOW_MS, 600000),
    healthTimeoutMs: o.healthTimeoutMs ?? num(env.HECATE_HEALTH_TIMEOUT_MS, 4000),
    firstTokenTimeoutMs: o.firstTokenTimeoutMs ?? num(env.HECATE_FIRST_TOKEN_TIMEOUT_MS, 180000),
    idleTimeoutMs: o.idleTimeoutMs ?? num(env.HECATE_IDLE_TIMEOUT_MS, 90000),
    contextChars: o.contextChars ?? num(env.HECATE_CONTEXT_CHARS, 48000),
    maxConcurrentRunsPerUser: num(env.HECATE_MAX_RUNS_PER_USER, 4),
    eventRetentionDays: num(env.HECATE_EVENT_RETENTION_DAYS, 3),

    ffmpeg: has('ffmpeg'),
    pdftotext: has('pdftotext'),
    unzip: has('unzip'),
  };
}
