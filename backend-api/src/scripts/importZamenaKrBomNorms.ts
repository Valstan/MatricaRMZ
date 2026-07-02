import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { LedgerTableName } from '@matricarmz/ledger';
import { resolveNomenclatureComponentTypeId } from '@matricarmz/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  directoryParts,
  entities,
  entityTypes,
  erpEngineAssemblyBomLines,
  erpNomenclature,
} from '../database/schema.js';
import { signAndAppendDetailed } from '../ledger/ledgerService.js';
import { createEntity, setEntityAttribute } from '../services/adminMasterdataService.js';
import { ensureNomenclatureBrandPart } from '../services/bomBrandPartSync.js';
import { getWarehouseAssemblyBom } from '../services/warehouseBomService.js';
import { serializeWarehouseBomLineMeta } from '../services/warehouseBomLineMeta.js';
import { createDirectoryPart, upsertWarehouseNomenclature } from '../services/warehouseService.js';

/**
 * Owner request 2026-07-02: import «Нормы расхода запасных частей при капитальном ремонте
 * дизельных двигателей В-59УМС (У), В-84АМС» (semicolon CSV, UTF-8) into the nomenclature
 * directory and the two engine-brand BOMs, WITHOUT creating duplicates.
 *
 * Mapping decision (owner delegated):
 *  - CSV «Категория» (24 values: Деталь / Сборочная единица / Болт / Шайба / Детали из
 *    резины / …) does NOT get a new column and does NOT replace our directories. It maps
 *    onto the existing «Группа номенклатуры» directory, consolidated:
 *      Сборочная единица → «Производство · Сборочные единицы (узлы)» (existing)
 *      Деталь / Кожух / Пломба → «Детали» (existing)
 *      крепёж (Болт/Гайка/Шайба/Шпилька/Винт/Штифт/Шплинт/Хомут/…) → «Крепёжные изделия» (new)
 *      резина/паронит/войлок/резинометалл → «РТИ и уплотнения» (new)
 *      Подшипник / Шарик / Ролик → «Подшипники» (new)
 *      Электрооборуд. и КИП → «Электрооборудование и КИП» (new)
 *    The fine-grained nature (Болт М10х30…) is already in the part name — no information loss.
 *  - CSV «Группа» (узел двигателя, e.g. «Группа 301 Картер») is BOM structure, not a global
 *    classifier — it goes into the BOM line notes, not into the nomenclature directory.
 *  - item_type: «Сборочная единица» → 'assembly', everything else → 'part'. Existing rows
 *    keep their item_type unless it is the legacy 'product'.
 *
 * Dedupe rules:
 *  - Primary match: normalized артикул (strip «сб.» prefix, parenthetical variants, spaces)
 *    against erp_nomenclature.code / directory_parts.code.
 *  - Secondary: a directory part with NO code whose name matches uniquely → adopt (set code).
 *  - Otherwise create via createDirectoryPart (mirrors into erp_nomenclature, signed path).
 *
 * BOM: merges into the existing brand BOMs (В-59 / В-84) via upsertWarehouseAssemblyBom
 * (full-replace semantics → existing lines are read and passed through; CSV wins on qty).
 * All client-visible writes go through the signed ledger path inside the services.
 *
 * Dry-run by default; pass --apply to mutate. --file <path> points at the UTF-8 CSV.
 */

const APPLY = process.argv.includes('--apply');
const fileArgIdx = process.argv.indexOf('--file');
const FILE = fileArgIdx >= 0 ? process.argv[fileArgIdx + 1] : null;
if (!FILE) {
  console.error('usage: tsx importZamenaKrBomNorms.ts --file <utf8-csv> [--apply]');
  process.exit(1);
}

// ensureOwner / change-log write the actor id into a uuid FK — needs a REAL employee
// (memory: server-script sync-write gotchas). Resolved to a superadmin at startup.
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

// Verified on prod 2026-07-02: «BOM В-59» → brands «В-59 УМС», «В-59»; «BOM В-84» (the
// populated one, 19 lines) → the В-84 family incl. «В-84 АМС».
const BOM_V59_ID = 'cc156ff4-efcd-4514-a089-9620069a6da7';
const BOM_V84_ID = '51d5dc51-1da6-4745-afe7-759a09a50c3b';

const GROUP_EXISTING_ASSEMBLY = 'Производство · Сборочные единицы (узлы)';
const GROUP_EXISTING_PARTS = 'Детали';
const GROUP_BY_CATEGORY: Record<string, string> = {
  'Сборочная единица': GROUP_EXISTING_ASSEMBLY,
  'Сбор-ная единица': GROUP_EXISTING_ASSEMBLY,
  'Деталь': GROUP_EXISTING_PARTS,
  'Кожух': GROUP_EXISTING_PARTS,
  'Пломба': GROUP_EXISTING_PARTS,
  'Болт': 'Крепёжные изделия',
  'Гайка': 'Крепёжные изделия',
  'Шайба': 'Крепёжные изделия',
  'Шайба пружинная': 'Крепёжные изделия',
  'Шпилька': 'Крепёжные изделия',
  'Винт': 'Крепёжные изделия',
  'Штифт': 'Крепёжные изделия',
  'Шплинт': 'Крепёжные изделия',
  'Хомут': 'Крепёжные изделия',
  'Детали из резины': 'РТИ и уплотнения',
  'Резинометал. изд.': 'РТИ и уплотнения',
  'Детали из паронита': 'РТИ и уплотнения',
  'Детали из войлока': 'РТИ и уплотнения',
  'Подшипник': 'Подшипники',
  'Шарик': 'Подшипники',
  'Ролик': 'Подшипники',
  'Электрооборуд. и КИП': 'Электрооборудование и КИП',
};

type CsvItem = {
  code: string;
  rawCode: string;
  name: string;
  category: string;
  engineNode: string;
  isAssembly: boolean;
  groupName: string;
  qty59: number;
  qty84: number;
};

function normCode(raw: string): string {
  let c = String(raw ?? '').trim();
  c = c.replace(/^сб\.\s*/i, '');
  c = c.replace(/\(.*?\)/g, '');
  return c.replace(/\s+/g, '');
}

/** Matching key: separator-folded (306-17-5 == 306.17.5 == 13,06,3304-style typos). */
function matchKey(raw: string): string {
  return normCode(raw).replace(/[.,]/g, '-');
}

function parseQty(raw: string): number {
  let v = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!v || v === '-') return 0;
  v = v.replace(/-+$/, ''); // source typo like «1-»
  const f = Number(v.replace(',', '.'));
  if (!Number.isFinite(f) || f < 0) return 0;
  return Math.trunc(f);
}

function parseCsv(path: string): { items: CsvItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const byCode = new Map<string, CsvItem>();
  for (let i = 6; i < lines.length; i += 1) {
    const cols = lines[i]!.split(';');
    if (cols.length < 7 || !String(cols[3] ?? '').trim()) continue;
    const rawCode = String(cols[3]).trim();
    let code = normCode(rawCode);
    const name = String(cols[4] ?? '').replace(/\s+/g, ' ').trim();
    let category = String(cols[2] ?? '').replace(/\s+/g, ' ').trim();
    const engineNode = String(cols[1] ?? '').replace(/\s+/g, ' ').trim();
    if (!category || category.startsWith('Группа') || category.startsWith('Гр.')) {
      warnings.push(`строка ${i + 1}: категория «${category}» → Деталь (${code})`);
      category = 'Деталь';
    }
    if (category === 'Сбор-ная единица') category = 'Сборочная единица';
    const qty59 = parseQty(String(cols[5] ?? ''));
    const qty84 = parseQty(String(cols[6] ?? ''));
    const existing = byCode.get(code);
    if (existing && existing.name !== name) {
      // Same обозначение, different part (e.g. хомуты sharing one ТУ) — disambiguate the
      // code with the distinguishing tail of the name (erp_nomenclature.code is unique).
      const tail = name.split(' ').slice(1).join(' ').trim() || String(byCode.size);
      const alt = `${code} ${tail}`.replace(/\s+/g, ' ');
      warnings.push(`строка ${i + 1}: артикул ${code} уже занят «${existing.name}» — «${name}» получает код «${alt}»`);
      code = alt;
    }
    const groupName = GROUP_BY_CATEGORY[category];
    if (!groupName) {
      warnings.push(`строка ${i + 1}: неизвестная категория «${category}» → Детали`);
    }
    const dup = byCode.get(code);
    if (dup) {
      warnings.push(`строка ${i + 1}: дубль ${code} «${name}» — количества суммируются (${dup.qty59}+${qty59} / ${dup.qty84}+${qty84})`);
      dup.qty59 += qty59;
      dup.qty84 += qty84;
      continue;
    }
    byCode.set(code, {
      code,
      rawCode,
      name,
      category,
      engineNode,
      isAssembly: category === 'Сборочная единица',
      groupName: groupName ?? GROUP_EXISTING_PARTS,
      qty59,
      qty84,
    });
  }
  return { items: Array.from(byCode.values()), warnings };
}

async function loadNomenclatureGroups(): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(entityTypes, and(eq(entityTypes.id, entities.typeId), eq(entityTypes.code, 'nomenclature_group')))
    .innerJoin(attributeDefs, and(eq(attributeDefs.entityTypeId, entityTypes.id), eq(attributeDefs.code, 'name')))
    .innerJoin(
      attributeValues,
      and(eq(attributeValues.entityId, entities.id), eq(attributeValues.attributeDefId, attributeDefs.id), isNull(attributeValues.deletedAt)),
    )
    .where(isNull(entities.deletedAt));
  const map = new Map<string, string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.valueJson));
      const name = typeof parsed === 'string' ? parsed : String((parsed as { value?: unknown })?.value ?? '');
      if (name.trim()) map.set(name.trim(), String(row.id));
    } catch {
      /* ignore malformed */
    }
  }
  return map;
}

async function ensureGroup(groups: Map<string, string>, name: string): Promise<string> {
  const found = groups.get(name);
  if (found) return found;
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'nomenclature_group'), isNull(entityTypes.deletedAt)))
    .limit(1);
  if (!typeRows[0]?.id) throw new Error('entity type nomenclature_group not found');
  const created = await createEntity(actor, String(typeRows[0].id));
  const attr = await setEntityAttribute(actor, created.id, 'name', name, { allowSyncConflicts: true });
  if (!attr.ok) throw new Error(`ensureGroup(${name}): ${attr.error}`);
  groups.set(name, created.id);
  console.log(`  + группа номенклатуры «${name}» создана (${created.id.slice(0, 8)})`);
  return created.id;
}

type NomRow = typeof erpNomenclature.$inferSelect;

async function main() {
  await resolveActor();
  const { items, warnings } = parseCsv(FILE!);
  console.log(`[import] CSV: ${items.length} уникальных позиций`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);

  const nomRows = await db.select().from(erpNomenclature).where(isNull(erpNomenclature.deletedAt));
  const partRows = await db
    .select({ id: directoryParts.id, name: directoryParts.name, code: directoryParts.code })
    .from(directoryParts)
    .where(isNull(directoryParts.deletedAt));

  const nomByCode = new Map<string, NomRow>();
  for (const row of nomRows) nomByCode.set(matchKey(String(row.code ?? '')), row as NomRow);
  const nomById = new Map<string, NomRow>();
  for (const row of nomRows) nomById.set(String(row.id), row as NomRow);
  const partByCode = new Map<string, { id: string; name: string; code: string | null }>();
  const codelessPartsByName = new Map<string, string[]>();
  for (const row of partRows) {
    const p = { id: String(row.id), name: String(row.name ?? ''), code: row.code == null ? null : String(row.code) };
    if (p.code && p.code.trim()) partByCode.set(matchKey(p.code), p);
    else {
      const key = p.name.trim().toLowerCase();
      codelessPartsByName.set(key, [...(codelessPartsByName.get(key) ?? []), p.id]);
    }
  }

  const groups = await loadNomenclatureGroups();
  const neededGroups = Array.from(new Set(items.map((i) => i.groupName)));
  const missingGroups = neededGroups.filter((g) => !groups.has(g));
  console.log(`[import] группы: нужно ${neededGroups.length}, отсутствуют: ${missingGroups.length ? missingGroups.join(', ') : 'нет'}`);

  const stats = { createdParts: 0, adoptedCode: 0, matched: 0, groupChanged: 0, itemTypeChanged: 0, codeFilled: 0, mirrorFailed: 0 };
  const plan: string[] = [];
  const nomIdByCsvCode = new Map<string, string>();

  if (APPLY) for (const g of missingGroups) await ensureGroup(groups, g);

  for (const item of items) {
    const codeKey = matchKey(item.code);
    let nom = nomByCode.get(codeKey) ?? null;
    let partId: string | null = nom?.directoryRefId ? String(nom.directoryRefId) : null;
    if (!nom) {
      const part = partByCode.get(codeKey) ?? null;
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
        // Consume the candidate: a second CSV item with the same name must CREATE,
        // not re-adopt (and silently overwrite) the same part.
        codelessPartsByName.delete(nameKey);
        stats.adoptedCode += 1;
        plan.push(`ADOPT  ${item.code} → бескодовая деталь «${item.name}» (${partId.slice(0, 8)}): проставляю артикул`);
        if (APPLY) {
          await db
            .update(directoryParts)
            .set({ code: item.code, updatedAt: Date.now() })
            .where(eq(directoryParts.id, partId));
        }
      }
    }

    if (!nom && !partId) {
      stats.createdParts += 1;
      if (APPLY) {
        let created = await createDirectoryPart({ name: item.name, code: item.code });
        if (!created.ok) {
          // «duplicate part exists: <id>» — the dedup key normalizes punctuation
          // (306-17-5 == 306.17.5), so recover by reusing the existing part.
          const dupId = /duplicate part exists: (\S+)/.exec(String(created.error))?.[1];
          if (dupId) {
            stats.createdParts -= 1;
            stats.matched += 1;
            plan.push(`REUSE  ${item.code} «${item.name}» — дубль-ключ указал на существующую деталь ${dupId.slice(0, 8)}`);
            created = { ok: true, part: { id: dupId } };
          } else {
            console.log(`  ✖ createDirectoryPart ${item.code} «${item.name}»: ${created.error}`);
            continue;
          }
        }
        partId = created.part.id;
        const freshRows = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, partId)).limit(1);
        nom = (freshRows[0] as NomRow | undefined) ?? null;
        if (!nom) {
          stats.mirrorFailed += 1;
          console.log(`  ✖ зеркало номенклатуры не создано для ${item.code} «${item.name}» — строка BOM пропущена`);
          continue;
        }
      }
    } else {
      stats.matched += 1;
    }

    // Dry-run for a to-be-created part: no nomenclature row yet — count and move on.
    if (!nom) {
      plan.push(`CREATE ${item.code} «${item.name}» [${item.groupName}${item.isAssembly ? ', assembly' : ''}]`);
      nomIdByCsvCode.set(item.code, `new:${item.code}`);
      continue;
    }

    nomIdByCsvCode.set(item.code, String(nom.id));

    const targetGroupId = APPLY ? await ensureGroup(groups, item.groupName) : (groups.get(item.groupName) ?? null);
    const currentCode = String(nom.code ?? '');
    const codeIsPlaceholder = /^(DET|NM)-/i.test(currentCode) || !currentCode.trim();
    const nextCode = codeIsPlaceholder ? item.code : currentCode;
    const currentItemType = String(nom.itemType ?? 'part');
    const nextItemType = item.isAssembly ? 'assembly' : currentItemType === 'product' ? 'part' : currentItemType;
    const groupDiffers = targetGroupId != null && String(nom.groupId ?? '') !== targetGroupId;
    const codeDiffers = nextCode !== currentCode;
    const typeDiffers = nextItemType !== currentItemType;
    if (!groupDiffers && !codeDiffers && !typeDiffers) continue;

    if (groupDiffers) stats.groupChanged += 1;
    if (typeDiffers) stats.itemTypeChanged += 1;
    if (codeDiffers) stats.codeFilled += 1;
    plan.push(
      `UPDATE ${currentCode || '(без кода)'} «${String(nom.name)}»:${codeDiffers ? ` code→${nextCode}` : ''}${typeDiffers ? ` type ${currentItemType}→${nextItemType}` : ''}${groupDiffers ? ` группа→${item.groupName}` : ''}`,
    );
    if (APPLY) {
      // Legacy rows may carry specJson.templateId pointing at a deleted template —
      // the upsert validates it and refuses. Dead reference → strip and retry once.
      let effectiveSpecJson = nom.specJson == null ? null : String(nom.specJson);
      const doUpsert = () =>
        upsertWarehouseNomenclature({
        id: String(nom!.id),
        code: nextCode,
        sku: nom.sku == null ? null : String(nom.sku),
        name: String(nom.name),
        itemType: nextItemType,
        category: nom.category == null ? null : String(nom.category),
        directoryKind: nom.directoryKind == null ? null : String(nom.directoryKind),
        directoryRefId: nom.directoryRefId == null ? null : String(nom.directoryRefId),
        groupId: targetGroupId ?? (nom.groupId == null ? null : String(nom.groupId)),
        unitId: nom.unitId == null ? null : String(nom.unitId),
        barcode: nom.barcode == null ? null : String(nom.barcode),
        minStock: nom.minStock == null ? null : Number(nom.minStock),
        maxStock: nom.maxStock == null ? null : Number(nom.maxStock),
        defaultBrandId: nom.defaultBrandId == null ? null : String(nom.defaultBrandId),
        isSerialTracked: Boolean(nom.isSerialTracked),
        defaultWarehouseId: nom.defaultWarehouseId == null ? null : String(nom.defaultWarehouseId),
        specJson: effectiveSpecJson,
        isActive: Boolean(nom!.isActive),
      });
      let res = await doUpsert();
      if (!res.ok && /шаблон номенклатуры не найден/i.test(String(res.error)) && effectiveSpecJson) {
        try {
          const spec = JSON.parse(effectiveSpecJson) as Record<string, unknown>;
          delete spec.templateId;
          effectiveSpecJson = JSON.stringify(spec);
          res = await doUpsert();
          if (res.ok) console.log(`  ~ ${item.code}: мёртвый templateId вычищен из specJson`);
        } catch {
          /* keep original error */
        }
      }
      if (!res.ok) console.log(`  ✖ upsertNomenclature ${item.code}: ${res.error}`);
      // Keep the freshly-assigned артикул in the part card too (spec/print surfaces read it).
      if (codeDiffers && nom.directoryKind === 'part' && nom.directoryRefId) {
        await db
          .update(directoryParts)
          .set({ code: nextCode, updatedAt: Date.now() })
          .where(and(eq(directoryParts.id, String(nom.directoryRefId)), isNull(directoryParts.code)));
      }
    }
  }

  console.log(`[import] детали: найдено по коду/имени ${stats.matched}, новых ${stats.createdParts}, принят артикул у бескодовых ${stats.adoptedCode}`);
  console.log(`[import] номенклатура: группа изменится у ${stats.groupChanged}, тип у ${stats.itemTypeChanged}, артикул заполнится у ${stats.codeFilled}`);
  const planSample = plan.slice(0, 25);
  for (const p of planSample) console.log(`  ${p}`);
  if (plan.length > planSample.length) console.log(`  … +${plan.length - planSample.length} ещё`);

  for (const [bomId, qtyKey, label] of [
    [BOM_V59_ID, 'qty59', 'В-59У/В-59УМС'],
    [BOM_V84_ID, 'qty84', 'В-84АМС'],
  ] as const) {
    const bomRes = await getWarehouseAssemblyBom({ id: bomId });
    if (!bomRes.ok) {
      console.log(`  ✖ BOM ${label} (${bomId}) не найден: ${bomRes.error}`);
      continue;
    }
    const header = bomRes.bom.header as { name?: string; engineBrandIds?: string[]; version?: number; notes?: string | null };
    const existingLines = bomRes.bom.lines as Array<{
      componentNomenclatureId: string;
      componentType: string;
      qtyPerUnit: number;
      variantGroup: string | null;
      lineKey: string | null;
      parentLineKey: string | null;
      isRequired: boolean;
      priority: number;
      notes: string | null;
    }>;
    // Line-level additive writes instead of upsertWarehouseAssemblyBom: the full-replace
    // upsert re-validates the WHOLE BOM, and the pre-existing owner-built kit variants on
    // prod legitimately fail today's stricter schema check (missing required 'ring') —
    // a legacy state this import must not touch. Direct insert/update + explicit ledger
    // sign (same payload shape as the service) keeps kits untouched and clients synced.
    const baseLineByNomId = new Map<string, { id?: string; qtyPerUnit: number }>();
    for (const line of existingLines) {
      if (line.variantGroup == null) {
        const lineId = (line as { id?: string }).id;
        baseLineByNomId.set(String(line.componentNomenclatureId), {
          ...(lineId ? { id: lineId } : {}),
          qtyPerUnit: Number(line.qtyPerUnit ?? 0),
        });
      }
    }
    const toInsert: Array<{ nomId: string; qty: number; note: string | null }> = [];
    const toUpdate: Array<{ lineId: string; nomId: string; qty: number }> = [];
    let skippedNew = 0;
    for (const item of items) {
      const qty = item[qtyKey];
      if (qty <= 0) continue;
      const nomId = nomIdByCsvCode.get(item.code);
      if (!nomId) continue;
      if (nomId.startsWith('new:')) {
        skippedNew += 1; // dry-run only: part not created yet, would be added on --apply
        continue;
      }
      const existing = baseLineByNomId.get(nomId);
      if (existing) {
        if (existing.qtyPerUnit !== qty && existing.id) toUpdate.push({ lineId: existing.id, nomId, qty });
      } else {
        toInsert.push({ nomId, qty, note: item.engineNode || null });
      }
    }
    console.log(
      `[import] BOM «${String(header.name)}» (${label}): строк было ${existingLines.length}, добавится ${toInsert.length + skippedNew}, количество обновится у ${toUpdate.length}${
        !APPLY && skippedNew ? ` (из них ${skippedNew} — по ещё не созданным деталям)` : ''
      }`,
    );
    if (APPLY) {
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
          .set({ qtyPerUnit: upd.qty, updatedAt: ts })
          .where(eq(erpEngineAssemblyBomLines.id, upd.lineId));
      }
      const touchedIds = [...newIds, ...toUpdate.map((u) => u.lineId)];
      const savedRows = touchedIds.length
        ? await db.select().from(erpEngineAssemblyBomLines).where(and(eq(erpEngineAssemblyBomLines.bomId, bomId), isNull(erpEngineAssemblyBomLines.deletedAt)))
        : [];
      const touchedSet = new Set(touchedIds);
      const signRows = savedRows.filter((row) => touchedSet.has(String(row.id)));
      if (signRows.length > 0) {
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
      }
      // «Деталь заведена как деталь марки» — the same guarantee hook the service runs
      // (part visible on the brand card with its qty). Best-effort per line.
      const hookActor = { id: actor.id, username: actor.username, role: actor.role } as Parameters<typeof ensureNomenclatureBrandPart>[0];
      for (const ins of toInsert) {
        const byBrand = new Map<string, number>();
        for (const brandId of brandIds) byBrand.set(brandId, ins.qty);
        await ensureNomenclatureBrandPart(hookActor, ins.nomId, byBrand).catch((e) =>
          console.log(`  ⚠ brand-part guarantee ${ins.nomId}: ${String(e)}`),
        );
      }
      console.log(`  BOM ${label}: вставлено ${newIds.length}, обновлено ${toUpdate.length}, подписано в ledger ${signRows.length}`);
    }
  }

  console.log(APPLY ? '[import] ✅ APPLY завершён' : '[import] DRY-RUN завершён — запусти с --apply для записи');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
