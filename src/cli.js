#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createInvite } from './admin.js';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, d) => { const i = rest.indexOf(`--${name}`); return i === -1 ? d : rest[i + 1]; };
const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'hecate.db'));

switch (cmd) {
  case 'invite': {
    const inv = createInvite(db, { note: opt('note', null), maxUses: Number(opt('uses', 1)), days: Number(opt('days', 14)) });
    console.log(`Invite code: ${inv.code}   (uses: ${inv.max_uses}, expires: ${inv.expires_at ? new Date(inv.expires_at).toLocaleString() : 'never'})`);
    break;
  }
  case 'users':
    for (const u of db.all('SELECT * FROM users ORDER BY created_at')) console.log(`${u.id}  ${u.role.padEnd(6)} ${u.disabled ? '[disabled] ' : ''}${u.display_name ?? ''} ${u.email ?? ''}`);
    break;
  case 'backup': {
    const file = path.resolve(rest[0] ?? path.join(config.dataDir, 'backups', `hecate-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db.backupTo(file);
    console.log(`Database backed up to ${file}\nAlso copy ${path.join(config.dataDir, 'files')} to back up attachments.`);
    break;
  }
  default:
    console.log('Usage: npm run cli -- <command>\n  invite [--uses N] [--days N] [--note TEXT]   create an invite code\n  users                                        list users\n  backup [FILE]                                back up the database');
}
db.close();
