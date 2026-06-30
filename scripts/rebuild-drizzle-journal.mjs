#!/usr/bin/env node
// Восстанавливает backend-api/drizzle/meta/_journal.json по
// drizzle.__drizzle_migrations на проде. Hash = sha256(содержимое SQL-файла).
//
// Usage:
//   node scripts/rebuild-drizzle-journal.mjs --prod-table prod-migrations.tsv [--write]
// где prod-migrations.tsv: id<TAB>hash<TAB>created_at, по строке на запись.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const drizzleDir = path.join(repoRoot, 'backend-api', 'drizzle');
const journalPath = path.join(drizzleDir, 'meta', '_journal.json');

const args = process.argv.slice(2);
const write = args.includes('--write');
const tablePathIdx = args.indexOf('--prod-table');
if (tablePathIdx === -1 || !args[tablePathIdx + 1]) {
  console.error('Usage: node scripts/rebuild-drizzle-journal.mjs --prod-table <tsv> [--include-missing tag1,tag2,...] [--write]');
  process.exit(1);
}
const tablePath = path.resolve(args[tablePathIdx + 1]);
const includeMissingIdx = args.indexOf('--include-missing');
const includeMissingTags =
  includeMissingIdx !== -1 && args[includeMissingIdx + 1]
    ? args[includeMissingIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : [];

const tableText = fs.readFileSync(tablePath, 'utf8');
const prodRows = tableText
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const [id, hash, createdAt] = l.split(/\t+/);
    return { id: Number(id), hash, createdAt: Number(createdAt) };
  });

console.log(`Prod records: ${prodRows.length}`);

const sqlFiles = fs
  .readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
console.log(`Local SQL files: ${sqlFiles.length}`);

const hashByTag = new Map();
const tagByHash = new Map();
function addHash(tag, content, variant) {
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  if (!tagByHash.has(hash)) tagByHash.set(hash, { tag, variant });
}
for (const file of sqlFiles) {
  const tag = file.replace(/\.sql$/, '');
  const raw = fs.readFileSync(path.join(drizzleDir, file), 'utf8');
  const lf = raw.replace(/\r\n/g, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  addHash(tag, raw, 'raw');
  addHash(tag, lf, 'lf');
  addHash(tag, crlf, 'crlf');
  hashByTag.set(tag, { raw, lf });
}

const matched = [];
const unmatchedProd = [];
for (const row of prodRows) {
  const m = tagByHash.get(row.hash);
  if (m) {
    matched.push({ ...row, tag: m.tag, variant: m.variant });
  } else {
    unmatchedProd.push(row);
  }
}
const variantCounts = matched.reduce((acc, m) => {
  acc[m.variant] = (acc[m.variant] || 0) + 1;
  return acc;
}, {});
console.log(`Variant breakdown:`, variantCounts);

const matchedTags = new Set(matched.map((m) => m.tag));
const unmatchedFiles = sqlFiles
  .map((f) => f.replace(/\.sql$/, ''))
  .filter((t) => !matchedTags.has(t));

console.log(`\nMatched: ${matched.length}/${prodRows.length}`);
console.log(`Unmatched prod records (no SQL file with this content): ${unmatchedProd.length}`);
for (const r of unmatchedProd) {
  console.log(`  id=${r.id} hash=${r.hash.slice(0, 16)}... created_at=${r.createdAt}`);
}
console.log(`\nLocal SQL files not in prod (never applied): ${unmatchedFiles.length}`);
for (const t of unmatchedFiles) console.log(`  ${t}`);

matched.sort((a, b) => a.id - b.id);

const lastProdCreatedAt = matched.reduce((max, m) => Math.max(max, m.createdAt), 0);
console.log(`\nLast prod created_at: ${lastProdCreatedAt}`);

const extraEntries = [];
const extraInsertSql = [];
let nextWhen = lastProdCreatedAt + 1000;
for (const tag of includeMissingTags) {
  if (!hashByTag.has(tag)) {
    console.error(`  --include-missing: tag "${tag}" has no SQL file — skipped`);
    continue;
  }
  if (matched.find((m) => m.tag === tag)) {
    console.warn(`  --include-missing: tag "${tag}" already matched on prod — skipped`);
    continue;
  }
  const { lf } = hashByTag.get(tag);
  const hash = crypto.createHash('sha256').update(lf).digest('hex');
  extraEntries.push({ tag, when: nextWhen, hash });
  extraInsertSql.push(
    `INSERT INTO drizzle.__drizzle_migrations ("hash","created_at") VALUES ('${hash}', ${nextWhen}); -- ${tag}`,
  );
  nextWhen += 1000;
}

const allEntries = [
  ...matched.map((m) => ({ tag: m.tag, when: m.createdAt })),
  ...extraEntries.map((e) => ({ tag: e.tag, when: e.when })),
].sort((a, b) => a.when - b.when);

const journal = {
  version: '7',
  dialect: 'postgresql',
  entries: allEntries.map((e, idx) => ({
    idx,
    version: '7',
    when: e.when,
    tag: e.tag,
    breakpoints: true,
  })),
};

if (extraEntries.length > 0) {
  console.log(`\n--- SQL to extend __drizzle_migrations on prod (${extraEntries.length} rows) ---`);
  for (const s of extraInsertSql) console.log(s);
}

console.log(`\nProposed journal entries: ${journal.entries.length}`);
console.log('First 3:', JSON.stringify(journal.entries.slice(0, 3), null, 2));
console.log('Last 3:', JSON.stringify(journal.entries.slice(-3), null, 2));

if (write) {
  const backup = `${journalPath}.bak.${Date.now()}`;
  if (fs.existsSync(journalPath)) {
    fs.copyFileSync(journalPath, backup);
    console.log(`\nBackup saved to ${backup}`);
  }
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, '\t') + '\n');
  console.log(`Journal written to ${journalPath}`);
} else {
  console.log('\nDry-run (no --write). Pass --write to overwrite the journal.');
}
