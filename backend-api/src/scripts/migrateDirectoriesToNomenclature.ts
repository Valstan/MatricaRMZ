/**
 * Миграция: данные из directory_parts / directory_tools / directory_goods / directory_services
 * и из EAV (entities + attribute_values) → erp_nomenclature.
 *
 * Запуск:
 *   pnpm --filter @matricarmz/backend-api masterdata:migrate-directories-to-nomenclature -- --dry-run
 *   pnpm --filter @matricarmz/backend-api masterdata:migrate-directories-to-nomenclature -- --commit
 *
 * Идемпотентен: для каждой записи в directory_* проверяет наличие erp_nomenclature
 * с directory_ref_id = id, и если нет — создаёт.
 */
import 'dotenv/config';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, pool } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  directoryGoods,
  directoryParts,
  directoryServices,
  directoryTools,
  entityTypes,
  erpNomenclature,
} from '../database/schema.js';

type Mode = 'dry-run' | 'commit';

function parseMode(): Mode {
  if (process.argv.includes('--commit')) return 'commit';
  return 'dry-run';
}

type DirectoryKind = 'part' | 'tool' | 'good' | 'service';

const KIND_TO_ITEM_TYPE: Record<DirectoryKind, string> = {
  part: 'part',
  tool: 'tool',
  good: 'good',
  service: 'service',
};

type LookupCtx = {
  groupIdByKind: Record<DirectoryKind, string | null>;
  unitId: string | null;
  templateIdByKind: Record<DirectoryKind, string | null>;
};

async function loadLookupCtx(): Promise<LookupCtx> {
  // Группы: ищем по «новым» названиям, при отсутствии — берём по подстроке
  const groupRows = await pool.query<{ id: string; name: string }>(
    `select e.id, av.value_json as name_json, kv.value_json as kind_json
     from entities e
     join entity_types t on t.id = e.type_id and t.code = 'nomenclature_group' and t.deleted_at is null
     join attribute_defs ad_name on ad_name.entity_type_id = t.id and ad_name.code = 'name' and ad_name.deleted_at is null
     left join attribute_values av on av.entity_id = e.id and av.attribute_def_id = ad_name.id and av.deleted_at is null
     left join attribute_defs ad_kind on ad_kind.entity_type_id = t.id and ad_kind.code = 'kind' and ad_kind.deleted_at is null
     left join attribute_values kv on kv.entity_id = e.id and kv.attribute_def_id = ad_kind.id and kv.deleted_at is null
     where e.deleted_at is null`,
  );
  const groups = groupRows.rows
    .map((r: any) => {
      let name = '';
      try {
        name = String(JSON.parse(String(r.name_json ?? 'null')) ?? '').trim();
      } catch { /* ignore malformed JSON */ }
      return { id: String(r.id), name };
    })
    .filter((row) => row.name);
  const findGroup = (...exact: string[]) => {
    for (const target of exact) {
      const t = target.toLowerCase();
      const hit = groups.find((g) => g.name.toLowerCase() === t);
      if (hit) return hit.id;
    }
    for (const target of exact) {
      const t = target.toLowerCase();
      const hit = groups.find((g) => g.name.toLowerCase().includes(t));
      if (hit) return hit.id;
    }
    return null;
  };
  const groupIdByKind: Record<DirectoryKind, string | null> = {
    part: findGroup('Производство · Детали собственного изготовления', 'Детали'),
    tool: findGroup('Закупка · Инструмент и оснастка', 'Инструменты'),
    good: findGroup('Закупка · Товары', 'Товары'),
    service: findGroup('Услуги · Собственные', 'Услуги · Подрядчиков', 'Услуги'),
  };

  // Единица измерения по умолчанию — первая попавшаяся
  const unitRows = await pool.query(
    `select e.id, av.value_json as name_json
     from entities e
     join entity_types t on t.id = e.type_id and t.code = 'unit' and t.deleted_at is null
     join attribute_defs ad on ad.entity_type_id = t.id and ad.code = 'name' and ad.deleted_at is null
     left join attribute_values av on av.entity_id = e.id and av.attribute_def_id = ad.id and av.deleted_at is null
     where e.deleted_at is null
     limit 50`,
  );
  const units = unitRows.rows
    .map((r: any) => {
      let name = '';
      try {
        name = String(JSON.parse(String(r.name_json ?? 'null')) ?? '').trim();
      } catch { /* ignore malformed JSON */ }
      return { id: String(r.id), name };
    })
    .filter((u) => u.name);
  const pickUnit = (...exact: string[]) => {
    for (const target of exact) {
      const t = target.toLowerCase();
      const hit = units.find((u) => u.name.toLowerCase() === t);
      if (hit) return hit.id;
    }
    return units[0]?.id ?? null;
  };
  const unitId = pickUnit('шт', 'штука', 'шт.');

  // Шаблоны по умолчанию из EAV-справочника nomenclature_template
  const tplRows = await pool.query(
    `select e.id, av_code.value_json as code_json, av_dk.value_json as dk_json
     from entities e
     join entity_types t on t.id = e.type_id and t.code = 'nomenclature_template' and t.deleted_at is null
     join attribute_defs ad_code on ad_code.entity_type_id = t.id and ad_code.code = 'code' and ad_code.deleted_at is null
     left join attribute_values av_code on av_code.entity_id = e.id and av_code.attribute_def_id = ad_code.id and av_code.deleted_at is null
     left join attribute_defs ad_dk on ad_dk.entity_type_id = t.id and ad_dk.code = 'directory_kind' and ad_dk.deleted_at is null
     left join attribute_values av_dk on av_dk.entity_id = e.id and av_dk.attribute_def_id = ad_dk.id and av_dk.deleted_at is null
     where e.deleted_at is null`,
  );
  const tpls = tplRows.rows.map((r: any) => {
    let code = '', dk = '';
    try { code = String(JSON.parse(String(r.code_json ?? 'null')) ?? '').trim().toLowerCase(); } catch { /* ignore malformed JSON */ }
    try { dk = String(JSON.parse(String(r.dk_json ?? 'null')) ?? '').trim().toLowerCase(); } catch { /* ignore malformed JSON */ }
    return { id: String(r.id), code, dk };
  });
  const findTpl = (kind: DirectoryKind) => {
    const want = `default_${kind}`;
    return (
      tpls.find((t) => t.code === want)?.id ??
      tpls.find((t) => t.dk === kind)?.id ??
      null
    );
  };
  const templateIdByKind: Record<DirectoryKind, string | null> = {
    part: findTpl('part'),
    tool: findTpl('tool'),
    good: findTpl('good'),
    service: findTpl('service'),
  };

  return { groupIdByKind, unitId, templateIdByKind };
}

async function loadEavAttributesForEntities(
  typeCode: string,
  entityIds: string[],
): Promise<Map<string, Record<string, string>>> {
  if (!entityIds.length) return new Map();
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, typeCode), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : '';
  if (!typeId) return new Map();
  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as any), isNull(attributeDefs.deletedAt)));
  const codeById = new Map(defs.map((d) => [String(d.id), String(d.code)]));
  const values = await db
    .select({ entityId: attributeValues.entityId, attrDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(inArray(attributeValues.entityId, entityIds as any), isNull(attributeValues.deletedAt)));
  const out = new Map<string, Record<string, string>>();
  for (const v of values) {
    const eid = String(v.entityId);
    const code = codeById.get(String(v.attrDefId));
    if (!code) continue;
    let raw: string;
    try {
      const parsed = JSON.parse(String(v.valueJson ?? 'null'));
      raw = parsed == null ? '' : String(parsed);
    } catch {
      raw = String(v.valueJson ?? '');
    }
    if (!raw) continue;
    const bucket = out.get(eid) ?? {};
    bucket[code] = raw;
    out.set(eid, bucket);
  }
  return out;
}

async function findExistingNomenclatureMap(kind: DirectoryKind, refIds: string[]): Promise<Map<string, string>> {
  if (!refIds.length) return new Map();
  const rows = await db
    .select({ id: erpNomenclature.id, refId: erpNomenclature.directoryRefId })
    .from(erpNomenclature)
    .where(
      and(
        eq(erpNomenclature.directoryKind, kind),
        inArray(erpNomenclature.directoryRefId, refIds as any),
        isNull(erpNomenclature.deletedAt),
      ),
    );
  return new Map(rows.map((r) => [String(r.refId), String(r.id)]));
}

function makeNomenclatureCode(prefix: string, existingCodes: Set<string>): string {
  let n = existingCodes.size + 1;
  while (true) {
    const code = `${prefix}-${String(n).padStart(6, '0')}`;
    if (!existingCodes.has(code)) {
      existingCodes.add(code);
      return code;
    }
    n += 1;
  }
}

const CODE_PREFIX_BY_KIND: Record<DirectoryKind, string> = {
  part: 'PT',
  tool: 'TL',
  good: 'GD',
  service: 'SV',
};

async function migrateKind(kind: DirectoryKind, mode: Mode, ctx: LookupCtx): Promise<{ total: number; created: number; existed: number }> {
  let directorySrc: any;
  let entityTypeCode: string;
  switch (kind) {
    case 'part':
      directorySrc = directoryParts;
      entityTypeCode = 'part';
      break;
    case 'tool':
      directorySrc = directoryTools;
      entityTypeCode = 'tool';
      break;
    case 'good':
      directorySrc = directoryGoods;
      entityTypeCode = 'product';
      break;
    case 'service':
      directorySrc = directoryServices;
      entityTypeCode = 'service';
      break;
  }

  const directoryRows = await db
    .select({ id: directorySrc.id, name: directorySrc.name, metadataJson: directorySrc.metadataJson })
    .from(directorySrc)
    .where(isNull(directorySrc.deletedAt));

  const refIds = directoryRows.map((r: any) => String(r.id));
  const existingMap = await findExistingNomenclatureMap(kind, refIds);

  const eavAttrs = await loadEavAttributesForEntities(entityTypeCode, refIds);
  const existingCodes = new Set<string>();
  const codeRows = await db.select({ code: erpNomenclature.code }).from(erpNomenclature);
  for (const r of codeRows) existingCodes.add(String(r.code ?? ''));

  let created = 0;
  let existed = 0;
  const ts = Date.now();
  const itemType = KIND_TO_ITEM_TYPE[kind];
  const groupId = ctx.groupIdByKind[kind];
  const unitId = ctx.unitId;
  const templateId = ctx.templateIdByKind[kind];

  for (const row of directoryRows) {
    const refId = String((row as any).id);
    if (existingMap.has(refId)) {
      existed += 1;
      continue;
    }

    const rawName = String((row as any).name ?? '').trim() || `${kind} ${refId.slice(0, 8)}`;
    let metaJson: Record<string, unknown> = {};
    try {
      const m = (row as any).metadataJson;
      if (m && typeof m === 'string') metaJson = JSON.parse(m) as Record<string, unknown>;
      else if (m && typeof m === 'object') metaJson = m as Record<string, unknown>;
    } catch { /* ignore malformed JSON */ }
    const eav = eavAttrs.get(refId) ?? {};
    const merged: Record<string, unknown> = { ...metaJson, ...eav };
    const propertyValues = Object.fromEntries(
      Object.entries(merged).filter(([k]) => !['name', 'code', 'sku', 'barcode'].includes(k)),
    );

    const code = String(merged.code ?? merged.sku ?? '').trim() || makeNomenclatureCode(CODE_PREFIX_BY_KIND[kind], existingCodes);
    const specJson = JSON.stringify({
      templateId: templateId ?? null,
      propertyValues,
    });

    if (mode === 'commit') {
      await db.insert(erpNomenclature).values({
        id: randomUUID(),
        code,
        sku: code,
        name: rawName,
        itemType,
        category: 'component',
        directoryKind: kind,
        directoryRefId: refId as any,
        groupId: groupId ? (groupId as any) : null,
        unitId: unitId ? (unitId as any) : null,
        barcode: typeof merged.barcode === 'string' ? String(merged.barcode) : null,
        specJson,
        isActive: true,
        isSerialTracked: false,
        defaultBrandId: null,
        defaultWarehouseId: null,
        minStock: null,
        maxStock: null,
        createdAt: ts,
        updatedAt: ts,
        deletedAt: null,
        syncStatus: 'synced',
      } as any);
    }
    created += 1;
  }

  return { total: directoryRows.length, created, existed };
}

async function main() {
  const mode = parseMode();
  console.log(`[миграция] режим=${mode}`);

  const ctx = await loadLookupCtx();
  console.log('[миграция] контекст групп/единиц/шаблонов:');
  console.log(`  groupIdByKind=${JSON.stringify(ctx.groupIdByKind)}`);
  console.log(`  unitId=${ctx.unitId ?? '—'}`);
  console.log(`  templateIdByKind=${JSON.stringify(ctx.templateIdByKind)}`);
  if (!ctx.unitId) {
    console.warn('[миграция] предупреждение: не найдена единица измерения по умолчанию, поле останется пустым');
  }

  const results: Record<string, { total: number; created: number; existed: number }> = {};
  for (const kind of ['part', 'tool', 'good', 'service'] as DirectoryKind[]) {
    results[kind] = await migrateKind(kind, mode, ctx);
  }

  console.log('\n[миграция] итог:');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(8)} → всего=${v.total}, ${mode === 'commit' ? 'создано' : 'будет создано'}=${v.created}, уже было=${v.existed}`);
  }
  if (mode === 'dry-run') {
    console.log('\n[миграция] это был dry-run. Чтобы записать изменения, запустите с флагом --commit');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
