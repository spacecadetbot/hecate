import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot } from './helpers.js';

// Keeps openapi.yaml honest: every real route is documented and every documented route exists.
test('openapi.yaml matches the routes the server actually serves', async () => {
  const yaml = fs.readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
  const documented = new Set(); let path = null;
  for (const line of yaml.split('\n')) {
    let m = /^  (\/[^\s:]*):\s*$/.exec(line);
    if (m) { path = m[1]; continue; }
    m = /^    (get|post|put|patch|delete):/.exec(line);
    if (m && path) documented.add(`${m[1].toUpperCase()} ${path}`);
    if (/^components:/.test(line)) path = null;
  }
  const ctx = await boot();
  try {
    const actual = new Set(ctx.gw.router.routes.map((r) => `${r.method} ${r.pattern.replace(/:([A-Za-z_]+)/g, '{$1}')}`));
    const undocumented = [...actual].filter((x) => !documented.has(x));
    const missing = [...documented].filter((x) => !actual.has(x));
    assert.deepEqual(undocumented, [], 'routes missing from openapi.yaml');
    assert.deepEqual(missing, [], 'openapi.yaml documents routes that do not exist');
  } finally { await ctx.close(); }
});
