import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { LedgerTableName } from '@matricarmz/ledger';
import { resolveNomenclatureComponentTypeId } from '@matricarmz/shared';
import type { PartDimension, PartSpec } from '@matricarmz/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { directoryParts, erpEngineAssemblyBomLines, erpNomenclature } from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { ensureNomenclatureBrandPart } from '../services/bomBrandPartSync.js';
import { getWarehouseAssemblyBom, upsertWarehouseAssemblyBom } from '../services/warehouseBomService.js';
import { parseWarehouseBomLineMeta, serializeWarehouseBomLineMeta } from '../services/warehouseBomLineMeta.js';
import {
  createDirectoryPart,
  getWarehouseNomenclaturePartSpec,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';

/**
 * Owner request 2026-07-17: import two «Нормы расходов» docs from Снабжение into
 * nomenclature + engine-brand BOMs, following the importZamenaKrBomNorms.ts precedent
 * (owner-ratified mapping 2026-07-02: qty-per-engine → BOM line, группа двигателя →
 * BOM line notes, NOT a separate norms document and NOT an engine-brand card tab):
 *
 *  - «Нормы расходов УТД 20» (ГОЗ № 2626187922481435541247710 от 02.06.2026):
 *    278 rows with Обозначение / Наименование / ГОСТ,ТУ / Материал / qty на 1 изделие /
 *    % нормы расхода. Target brands: «УТД-20», «УТД-20(С1)». No BOM exists for them —
 *    created here. Материал/ГОСТ land in the part spec dimensions («Материал», «ГОСТ, ТУ»).
 *
 *  - «ПЗ В-84 нов 1506 от Снабжения» (план закупок по нормам расхода, В-84/В-84С):
 *    195 rows (6 without qty — nomenclature-only). Merged line-level into the existing
 *    shared «BOM В-84» (51d5dc51…, linked to the whole В-84 family) — the same additive
 *    insert/update + explicit ledger sign as the precedent (full-replace upsert would
 *    re-validate legacy owner-built kit variants that predate today's stricter schema).
 *
 *  - «% норма расхода» has no typed home yet — stored human-readable in the BOM line
 *    notes text («Группа … · норма расхода N%»), same channel the precedent used for
 *    the engine node. A typed field can be added when the economists' report lands.
 *
 * Dry-run by default; --apply mutates. Data: src/scripts/data/norms-*.json (parsed
 * verbatim from the owner's docx, committed for provenance).
 */

const APPLY = process.argv.includes('--apply');
const HERE = dirname(fileURLToPath(import.meta.url));

const UTD20_BRAND_NAMES = ['УТД-20', 'УТД-20(С1)'];
// Verified on prod 2026-07-17: the populated «BOM В-84» (547 lines, В-84 family links).
const BOM_V84_ID = '51d5dc51-1da6-4745-afe7-759a09a50c3b';

type Utd20Row = { group: string; code: string; name: string; gost: string; material: string; qty: number; pct: number | null };
type V84Row = { group: string; code: string; name: string; qty: number; pct: number | null };

type NormItem = {
  code: string;
  rawCode: string;
  name: string;
  group: string;
  qty: number;
  pct: number | null;
  gost?: string;
  material?: string;
};

let actor: { id: string; username: string; role: 'superadmin' } = { id: '', username: '', role: 'superadmin' };

async function resolveActor(): Promise<void> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join entity_types et on et.id = e.type_id and et.code = 'employee'
       join attribute_defs srd on srd.entity_type_id = et.id and srd.code = 'system_role'
       join attribute_values sr on sr.entity_id = e.id and sr.attribute_def_id = srd.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json) = 'superadmin'
       left join attribute_defs lgd on lgd.entity_type_id = et.id and lgd.code = 'login'
       left join attribute_values lg on lg.entity_id = e.id and lg.attribute_def_id = lgd.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username limit 1`,
  );
  if (!r.rows[0]) throw new Error('no superadmin employee found for actor');
  actor = { id: String(r.rows[0].id), username: String(r.rows[0].username ?? 'superadmin'), role: 'superadmin' };
  console.log(`[import] actor: ${actor.username} (${actor.id.slice(0, 8)})`);
}

function normCode(raw: string): string {
  let c = String(raw ?? '').trim();
  // Both prefixes seen in the docs: cyrillic «сб.» and the latin-с homoglyph «cб.».
  c = c.replace(/^[cс]б\.\s*/i, '');
  c = c.replace(/\(.*?\)/g, '');
  return c.replace(/\s+/g, '');
}

function matchKey(raw: string): string {
  return normCode(raw).replace(/[.,]/g, '-');
}

function notesText(group: string, pct: number | null): string | null {
  const parts: string[] = [];
  if (group.trim()) parts.push(group.replace(/\s+/g, ' ').trim());
  if (pct != null && Number.isFinite(pct)) parts.push(`норма расхода ${pct}%`);
  return parts.length ? parts.join(' · ') : null;
}

function loadItems(): { utd20: NormItem[]; v84: NormItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const dedupe = (rows: NormItem[], label: string): NormItem[] => {
    const byCode = new Map<string, NormItem>();
    for (const row of rows) {
      let code = normCode(row.rawCode);
      if (!code) {
        warnings.push(`${label}: «${row.name}» без артикула — пропущена`);
        continue;
      }
      const existing = byCode.get(code);
      if (existing && existing.name !== row.name) {
        const tail = row.name.split(' ').slice(1).join(' ').trim() || String(byCode.size);
        const alt = `${code} ${tail}`.replace(/\s+/g, ' ');
        warnings.push(`${label}: артикул ${code} занят «${existing.name}» — «${row.name}» получает код «${alt}»`);
        code = alt;
      }
      const dup = byCode.get(code);
      if (dup) {
        warnings.push(`${label}: дубль ${code} «${row.name}» — количества суммируются (${dup.qty}+${row.qty})`);
        dup.qty += row.qty;
        continue;
      }
      byCode.set(code, { ...row, code });
    }
    return Array.from(byCode.values());
  };

  const utd20Raw = JSON.parse(readFileSync(join(HERE, 'data/norms-utd20-2026-07.json'), 'utf8')) as Utd20Row[];
  const v84Raw = JSON.parse(readFileSync(join(HERE, 'data/norms-v84-2026-07.json'), 'utf8')) as V84Row[];

  const utd20 = dedupe(
    utd20Raw.map((r) => ({
      code: '',
      rawCode: r.code,
      name: r.name.trim(),
      group: r.group,
      qty: Math.max(0, Math.trunc(Number(r.qty) || 0)),
      pct: r.pct,
      ...(r.gost?.trim() ? { gost: r.gost.trim() } : {}),
      ...(r.material?.trim() ? { material: r.material.trim() } : {}),
    })),
    'УТД-20',
  );
  const v84 = dedupe(
    v84Raw.map((r) => ({
      code: '',
      rawCode: r.code,
      name: r.name.trim(),
      group: r.group,
      qty: Math.max(0, Math.trunc(Number(r.qty) || 0)),
      pct: r.pct,
    })),
    'В-84',
  );
  return { utd20, v84, warnings };
}

async function resolveBrandIdsByNames(names: string[]): Promise<Map<string, string>> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from av.value_json) as name
       from entities e
       join entity_types et on et.id = e.type_id and et.code = 'engine_brand'
       join attribute_defs ad on ad.entity_type_id = et.id and ad.code = 'name'
       join attribute_values av on av.entity_id = e.id and av.attribute_def_id = ad.id and av.deleted_at is null
      where e.deleted_at is null`,
  );
  const map = new Map<string, string>();
  for (const row of r.rows) {
    const name = String(row.name ?? '').trim();
    if (names.includes(name)) map.set(name, String(row.id));
  }
  return map;
}

type NomRow = typeof erpNomenclature.$inferSelect;

type Matched = {
  nomId: string | null; // null in dry-run for to-be-created parts
  created: boolean;
  item: NormItem;
};

async function matchOrCreateParts(items: NormItem[], label: string): Promise<Matched[]> {
  const nomRows = await db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt));
  const partRows = await db
    .select({ id: directoryParts.id, name: directoryParts.name, code: directoryParts.code })
    .from(directoryParts)
    .where(isNull(directoryParts.deletedAt));

  const nomByCode = new Map<string, NomRow>();
  for (const row of nomRows) {
    const key = matchKey(String(row.code ?? ''));
    if (key) nomByCode.set(key, row as NomRow);
  }
  const nomById = new Map<string, NomRow>();
  for (const row of nomRows) nomById.set(String(row.id), row as NomRow);
  const partByCode = new Map<string, { id: string; code: string | null }>();
  const codelessPartsByName = new Map<string, string[]>();
  for (const row of partRows) {
    const code = row.code == null ? '' : String(row.code).trim();
    if (code) partByCode.set(matchKey(code), { id: String(row.id), code });
    else {
      const key = String(row.name ?? '').trim().toLowerCase();
      codelessPartsByName.set(key, [...(codelessPartsByName.get(key) ?? []), String(row.id)]);
    }
  }

  const out: Matched[] = [];
  const stats = { matched: 0, adopted: 0, created: 0, failed: 0 };
  for (const item of items) {
    const key = matchKey(item.code);
    let nom = nomByCode.get(key) ?? null;
    let partId: string | null = nom ? String(nom.id) : null;
    if (!nom) {
      const part = partByCode.get(key) ?? null;
      if (part) {
        partId = part.id;
        nom = nomById.get(part.id) ?? null;
      }
    }
    if (!nom && !partId) {
      const nameKey = item.name.trim().toLowerCase();
      const candidates = codelessPartsByName.get(nameKey) ?? [];
      if (candidates.length === 1) {
        partId = candidates[0]!;
        nom = nomById.get(partId) ?? null;
        codelessPartsByName.delete(nameKey);
        stats.adopted += 1;
        console.log(`  ADOPT  ${item.code} → бескодовая деталь «${item.name}» (${partId.slice(0, 8)})`);
        if (APPLY) {
          await db.update(directoryParts).set({ code: item.code, updatedAt: Date.now() }).where(eq(directoryParts.id, partId));
        }
      }
    }
    if (!nom && !partId) {
      if (!APPLY) {
        stats.created += 1;
        out.push({ nomId: null, created: true, item });
        continue;
      }
      let created = await createDirectoryPart({ name: item.name, code: item.code });
      if (!created.ok) {
        const dupId = /duplicate part exists: (\S+)/.exec(String(created.error))?.[1];
        if (dupId) created = { ok: true, part: { id: dupId } };
        else {
          stats.failed += 1;
          console.log(`  ✖ createDirectoryPart ${item.code} «${item.name}»: ${created.error}`);
          continue;
        }
      }
      stats.created += 1;
      out.push({ nomId: created.part.id, created: true, item });
      continue;
    }
    stats.matched += 1;
    out.push({ nomId: partId, created: false, item });
  }
  console.log(`[${label}] детали: совпало ${stats.matched}, принят артикул ${stats.adopted}, новых ${stats.created}${stats.failed ? `, ошибок ${stats.failed}` : ''}`);
  return out;
}

/** УТД-20: материал + ГОСТ в характеристики карточки детали (spec.dimensions). */
async function applyMaterials(matched: Matched[]): Promise<void> {
  let planned = 0;
  let changed = 0;
  for (const m of matched) {
    const { material, gost } = m.item;
    if (!material && !gost) continue;
    planned += 1;
    if (!APPLY || !m.nomId) continue;
    const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: m.nomId });
    if (!cur.ok) {
      console.log(`  ✖ spec read ${m.item.code}: ${cur.error}`);
      continue;
    }
    const spec: PartSpec = cur.spec ?? { code: m.item.code, dimensions: [], brandLinks: [] };
    const dims: PartDimension[] = Array.isArray(spec.dimensions) ? [...spec.dimensions] : [];
    let dirty = false;
    const upsertDim = (name: string, value: string) => {
      const existing = dims.find((d) => d.name.trim().toLowerCase() === name.toLowerCase());
      if (existing) {
        if (existing.value.trim() !== value) {
          existing.value = value;
          dirty = true;
        }
      } else {
        dims.push({ id: randomUUID(), name, value });
        dirty = true;
      }
    };
    if (material) upsertDim('Материал', material);
    if (gost) upsertDim('ГОСТ, ТУ', gost);
    if (!dirty) continue;
    const res = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: m.nomId,
      spec: { ...spec, dimensions: dims },
    });
    if (!res.ok) console.log(`  ✖ spec write ${m.item.code}: ${res.error}`);
    else changed += 1;
  }
  console.log(`[УТД-20] материал/ГОСТ: позиций с данными ${planned}${APPLY ? `, обновлено карточек ${changed}` : ''}`);
}

/** Line-level additive merge (precedent path): insert new, update qty+notes, sign ledger. */
async function mergeBomLines(bomId: string, matched: Matched[], label: string): Promise<void> {
  const bomRes = await getWarehouseAssemblyBom({ id: bomId });
  if (!bomRes.ok) {
    console.log(`  ✖ BOM ${label} (${bomId}) не найден: ${bomRes.error}`);
    return;
  }
  const header = bomRes.bom.header as { name?: string; engineBrandIds?: string[] };
  const existingLines = bomRes.bom.lines as Array<Record<string, unknown>>;
  const baseLineByNomId = new Map<string, { id: string; qtyPerUnit: number; notes: string | null }>();
  for (const line of existingLines) {
    if (line.variantGroup == null) {
      baseLineByNomId.set(String(line.componentNomenclatureId), {
        id: String(line.id),
        qtyPerUnit: Number(line.qtyPerUnit ?? 0),
        notes: line.notes == null ? null : String(line.notes),
      });
    }
  }

  const toInsert: Array<{ nomId: string; qty: number; note: string | null }> = [];
  const toUpdate: Array<{ lineId: string; qty: number; notes: string | null }> = [];
  let pendingNew = 0;
  for (const m of matched) {
    if (m.item.qty <= 0) continue;
    if (!m.nomId) {
      pendingNew += 1;
      continue;
    }
    const note = notesText(m.item.group, m.item.pct);
    const existing = baseLineByNomId.get(m.nomId);
    if (existing) {
      const meta = parseWarehouseBomLineMeta(existing.notes);
      const nextNotes = serializeWarehouseBomLineMeta({ ...meta, text: note ?? meta.text });
      if (existing.qtyPerUnit !== m.item.qty || nextNotes !== existing.notes) {
        toUpdate.push({ lineId: existing.id, qty: m.item.qty, notes: nextNotes });
      }
    } else {
      toInsert.push({ nomId: m.nomId, qty: m.item.qty, note });
    }
  }
  console.log(
    `[${label}] BOM «${String(header.name)}»: строк было ${existingLines.length}, добавится ${toInsert.length + pendingNew}, обновится ${toUpdate.length}${
      !APPLY && pendingNew ? ` (${pendingNew} — по ещё не созданным деталям)` : ''
    }`,
  );
  if (!APPLY) return;

  const brandIds = (header.engineBrandIds ?? []).map(String);
  const ts = Date.now();
  const newIds: string[] = [];
  for (const ins of toInsert) {
    const nomRow = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, ins.nomId)).limit(1);
    const componentType =
      resolveNomenclatureComponentTypeId({
        componentTypeId: nomRow[0]?.componentTypeId ?? null,
        specJson: nomRow[0]?.specJson ?? null,
        name: nomRow[0]?.name ?? null,
        code: nomRow[0]?.code ?? null,
        category: nomRow[0]?.category ?? null,
        itemType: nomRow[0]?.itemType ?? null,
      }) ?? 'other';
    const lineId = randomUUID();
    await db.insert(erpEngineAssemblyBomLines).values({
      id: lineId,
      bomId,
      componentNomenclatureId: ins.nomId,
      componentType,
      qtyPerUnit: ins.qty,
      variantGroup: null,
      isRequired: true,
      priority: 100,
      notes: serializeWarehouseBomLineMeta({ text: ins.note, lineKey: null, parentLineKey: null }),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
      lastServerSeq: null,
    });
    newIds.push(lineId);
  }
  for (const upd of toUpdate) {
    await db
      .update(erpEngineAssemblyBomLines)
      .set({ qtyPerUnit: upd.qty, notes: upd.notes, updatedAt: ts })
      .where(eq(erpEngineAssemblyBomLines.id, upd.lineId));
  }
  const touchedIds = new Set([...newIds, ...toUpdate.map((u) => u.lineId)]);
  if (touchedIds.size > 0) {
    const savedRows = await db
      .select()
      .from(erpEngineAssemblyBomLines)
      .where(and(eq(erpEngineAssemblyBomLines.bomId, bomId), isNull(erpEngineAssemblyBomLines.deletedAt)));
    const signRows = savedRows.filter((row) => touchedIds.has(String(row.id)));
    signAndAppendDetailed(
      signRows.map((line) => ({
        type: 'upsert' as const,
        table: LedgerTableName.ErpEngineAssemblyBomLines,
        row_id: String(line.id),
        row: {
          id: String(line.id),
          bom_id: String(line.bomId),
          component_nomenclature_id: String(line.componentNomenclatureId),
          component_type: String(line.componentType),
          qty_per_unit: Number(line.qtyPerUnit),
          variant_group: line.variantGroup ?? null,
          is_required: Boolean(line.isRequired),
          priority: Number(line.priority),
          notes: line.notes ?? null,
          created_at: Number(line.createdAt),
          updated_at: Number(line.updatedAt),
          deleted_at: line.deletedAt == null ? null : Number(line.deletedAt),
          sync_status: String(line.syncStatus ?? 'synced'),
          last_server_seq: line.lastServerSeq == null ? null : Number(line.lastServerSeq),
        },
        actor: { userId: actor.id, username: actor.username, role: actor.role },
        ts,
      })),
    );
    console.log(`  BOM ${label}: вставлено ${newIds.length}, обновлено ${toUpdate.length}, подписано в ledger ${signRows.length}`);
  }
  const hookActor = { id: actor.id, username: actor.username, role: actor.role } as Parameters<typeof ensureNomenclatureBrandPart>[0];
  for (const m of matched) {
    if (!m.nomId || m.item.qty <= 0) continue;
    const byBrand = new Map<string, number>();
    for (const brandId of brandIds) byBrand.set(brandId, m.item.qty);
    await ensureNomenclatureBrandPart(hookActor, m.nomId, byBrand).catch((e) =>
      console.log(`  ⚠ brand-part guarantee ${m.nomId}: ${String(e)}`),
    );
  }
}

/** УТД-20: BOM для марок не существует (проверено 2026-07-17) — создаётся сервисным upsert'ом. */
async function ensureUtd20Bom(brandIds: string[], matched: Matched[]): Promise<void> {
  const linked = await pool.query(
    `select distinct b.id::text as id
       from erp_engine_assembly_bom b
       join erp_engine_assembly_bom_brand_links bl on bl.bom_id = b.id
      where b.deleted_at is null and bl.engine_brand_id = any($1::uuid[])`,
    [brandIds],
  );
  if (linked.rows.length > 0) {
    const bomId = String(linked.rows[0]!.id);
    console.log(`[УТД-20] BOM уже существует (${bomId.slice(0, 8)}) — line-level merge`);
    await mergeBomLines(bomId, matched, 'УТД-20');
    return;
  }
  const withQty = matched.filter((m) => m.item.qty > 0);
  console.log(`[УТД-20] BOM отсутствует — будет создан «BOM УТД-20» на ${withQty.length} строк, марки: ${brandIds.length}`);
  if (!APPLY) return;

  const lines = [];
  for (const m of withQty) {
    if (!m.nomId) continue;
    const nomRow = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, m.nomId)).limit(1);
    const componentType =
      resolveNomenclatureComponentTypeId({
        componentTypeId: nomRow[0]?.componentTypeId ?? null,
        specJson: nomRow[0]?.specJson ?? null,
        name: nomRow[0]?.name ?? null,
        code: nomRow[0]?.code ?? null,
        category: nomRow[0]?.category ?? null,
        itemType: nomRow[0]?.itemType ?? null,
      }) ?? 'other';
    lines.push({
      componentNomenclatureId: m.nomId,
      componentType,
      qtyPerUnit: m.item.qty,
      variantGroup: null,
      isRequired: true,
      priority: 100,
      notes: serializeWarehouseBomLineMeta({ text: notesText(m.item.group, m.item.pct), lineKey: null, parentLineKey: null }),
    });
  }
  const res = await upsertWarehouseAssemblyBom({
    name: 'BOM УТД-20',
    engineBrandIds: brandIds,
    status: 'active',
    notes: 'Нормы расходов КИ (ГОЗ № 2626187922481435541247710 от 02.06.2026), импорт 2026-07-17',
    lines,
    actor: { id: actor.id, username: actor.username, role: actor.role } as Parameters<typeof upsertWarehouseAssemblyBom>[0]['actor'],
  });
  if (!res.ok) {
    console.log(`  ✖ создание BOM УТД-20: ${res.error}`);
    return;
  }
  for (const w of res.warnings ?? []) console.log(`  ⚠ ${w}`);
  console.log(`  BOM УТД-20 создан (${res.id.slice(0, 8)}), строк: ${lines.length}`);
}

async function main() {
  await resolveActor();
  const { utd20, v84, warnings } = loadItems();
  console.log(`[import] УТД-20: ${utd20.length} позиций; В-84: ${v84.length} позиций (${v84.filter((i) => i.qty <= 0).length} без количества — только номенклатура)`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);

  const utdBrands = await resolveBrandIdsByNames(UTD20_BRAND_NAMES);
  for (const n of UTD20_BRAND_NAMES) {
    if (!utdBrands.has(n)) throw new Error(`марка «${n}» не найдена в базе`);
  }

  console.log('— УТД-20 —');
  const utdMatched = await matchOrCreateParts(utd20, 'УТД-20');
  await ensureUtd20Bom(Array.from(utdBrands.values()), utdMatched);
  await applyMaterials(utdMatched);

  console.log('— В-84 —');
  const v84Matched = await matchOrCreateParts(v84, 'В-84');
  await mergeBomLines(BOM_V84_ID, v84Matched, 'В-84');

  console.log(APPLY ? '[import] ✅ APPLY завершён' : '[import] DRY-RUN завершён — запусти с --apply для записи');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
