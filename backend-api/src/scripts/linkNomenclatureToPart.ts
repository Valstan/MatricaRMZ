import 'dotenv/config';

import { and, eq, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { directoryParts, erpNomenclature } from '../database/schema.js';
import { upsertWarehouseNomenclature } from '../services/warehouseService.js';

// Deep-dedup Ф2 helper: link an EXISTING erp_nomenclature row to a
// directory_parts row as its mirror (directory_kind='part' + directory_ref_id),
// instead of creating a duplicate nomenclature. For the code-collision case the
// orphan backfill refuses by design: the part's article is already used by a
// live legacy nomenclature row (e.g. «Гильза» 303-07-22), so the right move is
// to adopt that row, keeping its movement history.
//
// Write goes through upsertWarehouseNomenclature — the canonical nomenclature
// write path (direct PG upsert + signAndAppendDetailed to the ledger clients
// pull from). NOT recordSyncChanges: applyPushBatch has no ERP-table branches,
// so that path signs the ledger but silently never lands in PG (learned live
// on the first «Гильза» apply attempt, 2026-07-12).
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
        '  --apply              Write (canonical upsertWarehouseNomenclature path). Default is dry-run.',
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

    // Full-row upsert: pass every current value so the normalized SET does not
    // blank fields the link does not touch.
    const res = await upsertWarehouseNomenclature({
      id: nomenclatureId,
      code: String(nom.code ?? ''),
      sku: nom.sku ?? null,
      name: takeName ? String(part.name) : String(nom.name),
      itemType: String(nom.itemType ?? 'product'),
      category: nom.category ?? null,
      directoryKind: 'part',
      directoryRefId: partId,
      groupId: nom.groupId == null ? null : String(nom.groupId),
      unitId: nom.unitId == null ? null : String(nom.unitId),
      barcode: nom.barcode ?? null,
      minStock: nom.minStock == null ? null : Number(nom.minStock),
      maxStock: nom.maxStock == null ? null : Number(nom.maxStock),
      defaultBrandId: nom.defaultBrandId == null ? null : String(nom.defaultBrandId),
      isSerialTracked: Boolean(nom.isSerialTracked),
      defaultWarehouseId: nom.defaultWarehouseId == null ? null : String(nom.defaultWarehouseId),
      specJson: nom.specJson ?? null,
      componentTypeId: nom.componentTypeId == null ? null : String(nom.componentTypeId),
      isActive: Boolean(nom.isActive),
    });
    if (!res.ok) {
      console.error(`link failed: ${res.error}`);
      process.exitCode = 1;
      return;
    }
    const check = await db
      .select({ kind: erpNomenclature.directoryKind, ref: erpNomenclature.directoryRefId })
      .from(erpNomenclature)
      .where(eq(erpNomenclature.id, nomenclatureId))
      .limit(1);
    if (String(check[0]?.kind ?? '') !== 'part' || String(check[0]?.ref ?? '') !== partId) {
      console.error('link verify failed: PG row does not show the expected directory link');
      process.exitCode = 1;
      return;
    }
    console.log('');
    console.log('Linked and verified in PG (ledger signed — clients will pull it).');
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
