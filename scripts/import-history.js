#!/usr/bin/env node
// Usage: node --experimental-sqlite scripts/import-history.js <history.jsonl> [--skip <from>,<to>]...
// Stop the tracker first (or restart it afterwards) so it picks up the imported data.
// See src/history-import.js for the file format.
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { parseHistory, importHistory } from '../src/history-import.js';

const args = process.argv.slice(2);
const skip = [];
let file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--skip') {
    const [a, b] = String(args[++i] || '').split(',').map((x) => Math.floor(Date.parse(x) / 1000));
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) { console.error('--skip needs two dates: --skip 2025-06-01T00:00Z,2025-06-08T00:00Z'); process.exit(1); }
    skip.push([a, b]);
  } else file = args[i];
}
if (!file) { console.error('Usage: import-history.js <history.jsonl> [--skip <from>,<to>]'); process.exit(1); }

const db = openDb();
const snaps = parseHistory(fs.readFileSync(file, 'utf8'));
const r = importHistory(db, loadConfig(db), snaps, { skip });
console.log(`Read ${snaps.length} snapshots: ${r.snapshots} added to the value chart (${r.leftOut} left out), ${r.prices} daily prices, ${r.categories} asset categories.`);
console.log('Restart the tracker to use them.');
