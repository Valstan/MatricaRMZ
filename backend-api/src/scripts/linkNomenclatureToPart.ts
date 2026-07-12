import 'dotenv/config';

import { and, eq, isNull } from 'drizzle-orm';

import { SyncTableName, SyncTableRegistry } from '@matricarmz/shared';

import { db, pool } from '../database/db.js';
import { directoryParts, erpNomenclature } from '../database/schema.js';
import { recordSyncChanges } from '../services/sync/syncChangeService.js';

// Deep-dedup Ф2 helper: link an EXISTING erp_nomenclature row to a
// directory_parts row as its mirror (directory_kind='part' + directory_ref_id),
// instead of creating a duplicate nomenclature. For the code-collision case the
// orphan backfill refuses by design: the part's article is already used by a
// live legacy nomenclature row (e.g. «Гильза» 303-07-22), so the right move is
// to adopt that row, keeping its movement history.
//
// erp_nomenclature IS synced → the write goes through recordSyncChanges
// (ledger → index → PG, bumps last_server_seq) so clients pull it; a plain SQL
// UPDATE would stay invisible to incremental pull.
//
// Usage:
//   pnpm -F @matricarmz/backend-api warehouse:link-nomenclature-to-part -- --nomenclature <id> --part <id> [--take-name] [--apply]

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return String(process.argv[idx + 1]);
  const pref = process.argv.find((a) => a.startsWith(`${name}=`));
  return pref ? pref.slice(name.length + 1) : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const apply = hasFlag('--apply');
  const takeName = hasFlag('--take-name');
  const nomenclatureId = argValue('--nomenclature');
  const partId = argValue('--part');
  if (hasFlag('--help') || hasFlag('-h') || !nomenclatureId || !partId) {
    console.log(
      [
        'Usage: tsx src/scripts/linkNomenclatureToPart.ts --nomenclature <id> --part <id> [--take-name] [--apply]',
        '',
        '  --nomenclature <id>  Existing live erp_nomenclature row to adopt as the mirror.',
        '  --part <id>          Live directory_parts row it should mirror.',
        '  --take-name          Also copy the part name onto the nomenclature row.',
        '  --apply              Write (through recordSyncChanges). Default is dry-run.',
      ].join('\n'),
    );
    await pool.end();
    if (!hasFlag('--help') && !hasFlag('-h')) process.exitCode = 2;
    return;
  }

  try {
    const nomRows = await db
      .select()
      .from(erpNomenclature)
      .where(and(eq(erpNomenclature.id, nomenclatureId), isNull(erpNomenclature.deletedAt)))
      .limit(1);
    const nom = nomRows[0];
    if (!nom) {
      console.error(`erp_nomenclature ${nomenclatureId} not found or deleted`);
      process.exitCode = 1;
      return;
    }
    const partRows = await db
      .select({ id: directoryParts.id, name: directoryParts.name, code: directoryParts.code })
      .from(directoryParts)
      .where(and(eq(directoryParts.id, partId), isNull(directoryParts.deletedAt)))
      .limit(1);
    const part = partRows[0];
    if (!part) {
      console.error(`directory_parts ${partId} not found or deleted`);
      process.exitCode = 1;
      return;
    }

    const existingRef = String(nom.directoryRefId ?? '');
    if (existingRef && existingRef !== partId) {
      console.error(`erp_nomenclature ${nomenclatureId} already mirrors another part: ${existingRef}`);
      process.exitCode = 1;
      return;
    }
    const mirrorRows = await db
      .select({ id: erpNomenclature.id })
      .from(erpNomenclature)
      .where(and(eq(erpNomenclature.directoryRefId, partId), isNull(erpNomenclature.deletedAt)))
      .limit(1);
    if (mirrorRows[0] && String(mirrorRows[0].id) !== nomenclatureId) {
      console.error(`part ${partId} already has a live mirror: ${String(mirrorRows[0].id)}`);
      process.exitCode = 1;
      return;
    }

    console.log(`nomenclature: ${nomenclatureId} "${String(nom.name)}" code=${String(nom.code ?? '') || '(none)'}`);
    console.log(`part:         ${partId} "${String(part.name)}" code=${String(part.code ?? '') || '(none)'}`);
    console.log(`plan: directory_kind='part', directory_ref_id=${partId}${takeName ? `, name="${String(part.name)}"` : ''}`);

    if (!apply) {
      console.log('');
      console.log('Dry-run. Re-run with --apply to link.');
      return;
    }

    const ts = Date.now();
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.ErpNomenclature, nom as unknown as Record<string, unknown>);
    dto.directory_kind = 'part';
    dto.directory_ref_id = partId;
    if (takeName) dto.name = String(part.name);
    dto.updated_at = ts;
    const actor = { id: 'system', username: 'link-nomenclature-to-part', role: 'system' as const };
    await recordSyncChanges(actor, [
      { tableName: SyncTableName.ErpNomenclature, rowId: nomenclatureId, op: 'upsert', payload: dto },
    ]);
    console.log('');
    console.log('Linked (written through recordSyncChanges — clients will pull it).');
  } finally {
    await pool.end();
  }
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('linkNomenclatureToPart.ts');
if (isDirectRun) {
  void main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(2);
  });
}
