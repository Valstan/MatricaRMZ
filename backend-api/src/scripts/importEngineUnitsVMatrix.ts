// Импорт деталей из Excel-матриц владельца «Наименование единиц в ДВС В-46 / В-84»
// (2026-06-17). Матрица: строки = деталь (название + обозначение/артикул), столбцы =
// марки двигателей, «+» на пересечении = деталь входит в эту марку.
//
// Решения владельца 2026-06-17:
//   • Детали заводятся в номенклатуру (directory_parts) без дублей — ключ (название+артикул).
//   • Каждая привязывается ТОЛЬКО к своим маркам (по матрице), не ко всем.
//   • Все детали — БАЗОВЫЕ: в привязанных марках ставятся ОБА флага акта
//     (inCompletenessAct + inDefectAct).
//   • Пустые столбцы марок (В-46 базовая, В-55, В-55 У, В-59) и безымянные
//     столбцы «модификаций сборок» В-84 — НЕ обрабатываются.
//   • Детали без «+» ни в одной марке — НЕ обрабатываются.
//   • Маппинг марок Excel→база: В-84 А→«В-84 АМС», В-84 МБ1→«В-84 МБ-1С»,
//     В-59 У→«В-59 УМС»; В-46-4 / В-46-5 М / В-84 М — создаются новыми;
//     В-46-2С1 / В-46-5 / В-46-6 / В-84 / В-84-1 — точное совпадение с базой.
//   • «Картер верх.» (В-84) приведён к «Картер верхний» (так в базе, тот же 3301-15-30).
//
// Решения владельца по сверке с прод-базой 2026-06-17:
//   • Канонические имена базы вместо коротких из Excel: Головка→«Головка блока»,
//     Рубашка→«Рубашка цилиндров», Поршень 3304-05-24-01 → существующая
//     «Поршень 3304-05-24-01» (совпадающие по артикулу — переиспользуются без дублей).
//   • Конфликт артикула 406-12-44: верно «Блок правый» (Excel) — создаётся новой
//     деталью; существующая «Крышка люка 406-12-44» владельцем проверяется отдельно.
//
// Похожие, но не точные пары импорт НЕ сливает — выводит fuzzy-кандидатов в отчёт.
//
// Запуск: corepack pnpm -F @matricarmz/backend-api warehouse:import-v-matrix          (dry-run)
//         corepack pnpm -F @matricarmz/backend-api warehouse:import-v-matrix --apply
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AttributeDataType, EntityTypeCode, directoryPartIdentityKey, groupDirectoryPartDuplicates } from '@matricarmz/shared';
import type { PartSpecBrandLink } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeValues, entities, entityTypes, attributeDefs } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { createEntity, setEntityAttribute, upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import {
  createDirectoryPart,
  getWarehouseNomenclaturePartSpec,
  listWarehouseNomenclaturePartSpecs,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';

const APPLY = process.argv.includes('--apply');

// Марки, которых нет в базе — создаются новыми (решение владельца 2026-06-17).
const NEW_BRANDS = new Set<string>(['В-46-4', 'В-46-5 М', 'В-84 М']);

type PartRow = { name: string; code: string | null; brands: string[] };

// ── Данные (сгенерированы из Excel-матриц с маппингом марок, 2026-06-17) ──────────
const PARTS: PartRow[] = [
  { name: 'Картер верхний', code: '3301-16-39', brands: ['В-46-6'] },
  { name: 'Картер нижний', code: '406-06-43', brands: ['В-46-6', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Блок правый', code: '406-12-44', brands: ['В-46-6'] },
  { name: 'Блок левый', code: '406-13-44', brands: ['В-46-6'] },
  { name: 'Блок правый', code: '406-12-38', brands: ['В-46-5 М', 'В-46-6', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С'] },
  { name: 'Блок левый', code: '406-13-38', brands: ['В-46-5 М', 'В-46-6', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С'] },
  { name: 'Блок правый', code: '406-12-41', brands: ['В-46-4', 'В-46-5'] },
  { name: 'Блок левый', code: '406-13-41', brands: ['В-46-4', 'В-46-5'] },
  { name: 'Блок правый', code: '406-12-42', brands: ['В-46-2С1'] },
  { name: 'Блок левый', code: '406-13-42', brands: ['В-46-2С1'] },
  { name: 'Рубашка цилиндров правая', code: '303-06-18', brands: ['В-46-6'] },
  { name: 'Рубашка цилиндров левая', code: '303-02-16', brands: ['В-46-6', 'В-59 УМС', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Головка блока правая', code: '306-16-19', brands: ['В-46-2С1', 'В-46-4', 'В-46-5', 'В-46-5 М', 'В-46-6'] },
  { name: 'Головка блока левая', code: '306-34-19', brands: ['В-46-2С1', 'В-46-4', 'В-46-5', 'В-46-5 М', 'В-46-6'] },
  { name: 'Крышка головки правая', code: '406-08-3', brands: ['В-46-2С1'] },
  { name: 'Крышка головки левая', code: '306-09-8', brands: ['В-46-2С1'] },
  { name: 'Крышка головки правая', code: '406-08-2', brands: ['В-46-4', 'В-46-5', 'В-59 УМС'] },
  { name: 'Крышка головки левая', code: '306-09-7', brands: ['В-46-4', 'В-46-5', 'В-59 УМС'] },
  { name: 'Крышка головки правая', code: '306-08-8', brands: ['В-46-5 М', 'В-46-6', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Крышка головки левая', code: '306-09-10', brands: ['В-46-5 М', 'В-46-6', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Поршень 3304-05-24-01', code: '3304-05-24-01', brands: ['В-46-6', 'В-59 УМС', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Гильза стальная', code: '303-07-22', brands: ['В-46-6', 'В-59 УМС'] },
  { name: 'Картер верхний', code: '3301-15-30', brands: ['В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Картер верхний', code: '3301-15-40', brands: ['В-59 УМС'] },
  { name: 'Картер нижний', code: '402-06-37', brands: ['В-59 УМС'] },
  { name: 'Блок правый', code: '303-00-16', brands: ['В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С'] },
  { name: 'Блок левый', code: '303-01-16', brands: ['В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С'] },
  { name: 'Блок правый', code: '406-12-46', brands: ['В-84 М'] },
  { name: 'Блок левый', code: '406-13-46', brands: ['В-84 М'] },
  { name: 'Блок правый', code: '303-00-28', brands: ['В-84 М'] },
  { name: 'Блок левый', code: '303-01-28', brands: ['В-84 М'] },
  { name: 'Блок правый', code: '406-12-63', brands: ['В-59 УМС'] },
  { name: 'Блок левый', code: '406-13-63', brands: ['В-59 УМС'] },
  { name: 'Рубашка цилиндров правая', code: '303-06-18/303-03-11', brands: ['В-59 УМС', 'В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Головка блока правая', code: '306-01-20', brands: ['В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Головка блока левая', code: '306-02-20', brands: ['В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
  { name: 'Головка блока правая', code: '306-01-26', brands: ['В-59 УМС'] },
  { name: 'Головка блока левая', code: '306-02-26', brands: ['В-59 УМС'] },
  { name: 'Гильза стальная', code: '303-07-22-01', brands: ['В-84', 'В-84 АМС', 'В-84-1', 'В-84 МБ-1С', 'В-84 М'] },
];

async function actor(): Promise<AuthUser> {
  const id = await getSuperadminUserId();
  if (!id) throw new Error('Пользователь superadmin не найден');
  return { id, username: 'superadmin', role: 'superadmin' };
}

async function ensureBrandInfra(a: AuthUser) {
  const t = await upsertEntityType(a, { code: EntityTypeCode.EngineBrand, name: 'Марка двигателя' });
  if (!t.ok || !t.id) throw new Error('Не удалось подготовить тип марки двигателя');
  const d = await upsertAttributeDef(a, { entityTypeId: t.id, code: 'name', name: 'Название', dataType: AttributeDataType.Text, sortOrder: 10 });
  if (!d.ok || !d.id) throw new Error('Не удалось подготовить атрибут name марки');
  return { brandTypeId: t.id };
}

async function loadBrands(): Promise<Array<{ id: string; name: string }>> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'engine_brand'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id;
  if (!typeId) return [];
  const defRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  const nameDefId = defRows[0]?.id;
  if (!nameDefId) return [];
  const rows = await db
    .select({ id: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(and(eq(entities.typeId, typeId), isNull(entities.deletedAt), eq(attributeValues.attributeDefId, nameDefId), isNull(attributeValues.deletedAt)))
    .limit(10000);
  return rows.map((r) => {
    let name = '';
    try {
      const parsed = JSON.parse(String(r.valueJson ?? ''));
      name = typeof parsed === 'string' ? parsed : String(parsed ?? '');
    } catch {
      name = String(r.valueJson ?? '');
    }
    return { id: String(r.id), name: name.trim() };
  });
}

async function main() {
  console.log(`=== Импорт деталей В-46/В-84 — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);
  const a = await actor();

  // ── Марки ──
  const brandNames = [...new Set(PARTS.flatMap((p) => p.brands))].sort((x, y) => x.localeCompare(y));
  const existingBrands = await loadBrands();
  const brandIdByName = new Map<string, string>();
  for (const b of existingBrands) if (!brandIdByName.has(b.name)) brandIdByName.set(b.name, b.id);

  const brandsMatched: string[] = [];
  const brandsToCreate: string[] = [];
  const brandsUnresolved: string[] = [];
  for (const name of brandNames) {
    if (brandIdByName.has(name)) brandsMatched.push(name);
    else if (NEW_BRANDS.has(name)) brandsToCreate.push(name);
    else brandsUnresolved.push(name);
  }
  if (brandsUnresolved.length) {
    throw new Error(`Марки не найдены в базе и не помечены к созданию: ${brandsUnresolved.join(', ')}`);
  }

  // ── Детали ──
  const listed = await listWarehouseNomenclaturePartSpecs();
  if (!listed.ok) throw new Error(`не удалось загрузить детали: ${listed.error}`);
  const existing = listed.rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null }));
  const existingByKey = new Map(existing.map((p) => [directoryPartIdentityKey(p.name, p.code), p]));

  const matched: Array<{ part: PartRow; existingId: string }> = [];
  const toCreate: PartRow[] = [];
  for (const part of PARTS) {
    const ex = existingByKey.get(directoryPartIdentityKey(part.name, part.code));
    if (ex) matched.push({ part, existingId: ex.id });
    else toCreate.push(part);
  }

  // Fuzzy-кандидаты: новые детали против базы — на ручной триаж, импорт не сливает.
  const fuzzyInput = [
    ...existing.map((p) => ({ id: `ex:${p.id}`, name: p.name, code: p.code })),
    ...toCreate.map((t, i) => ({ id: `new:${i}`, name: t.name, code: t.code })),
  ];
  const fuzzyGroups = groupDirectoryPartDuplicates(fuzzyInput).filter(
    (g) => g.kind === 'fuzzy' && g.ids.some((id) => id.startsWith('new:')),
  );

  const totalLinks = PARTS.reduce((s, p) => s + p.brands.length, 0);

  // ── Отчёт ──
  console.log(`Марки (целевых ${brandNames.length}): уже есть ${brandsMatched.length}, создать ${brandsToCreate.length}`);
  if (brandsToCreate.length) console.log(`  + новые марки: ${brandsToCreate.join(', ')}`);
  console.log('');
  console.log(`Детали в базе: ${existing.length}`);
  console.log(`Целевых деталей списка: ${PARTS.length} (уникальных по название+артикул)`);
  console.log(`  — уже есть (совпала пара название+артикул): ${matched.length}`);
  console.log(`  — будет создано: ${toCreate.length}`);
  console.log(`Привязок деталь→марка: ${totalLinks} (каждая — с флагами «акт комплектности» + «акт дефектовки»)\n`);

  if (matched.length) {
    console.log('Уже есть (привяжем к маркам + проставим флаги актов):');
    for (const m of matched) console.log(`  = ${m.part.name}${m.part.code ? ` [${m.part.code}]` : ''} → ${m.part.brands.join(', ')}`);
    console.log('');
  }
  if (toCreate.length) {
    console.log('Создаваемые детали:');
    for (const t of toCreate) console.log(`  + ${t.name}${t.code ? ` [${t.code}]` : ' [без артикула]'} → ${t.brands.join(', ')}`);
    console.log('');
  }
  if (fuzzyGroups.length) {
    console.log('⚠️ Fuzzy-кандидаты (похожи на существующие — проверь руками, импорт НЕ объединяет):');
    const labelOf = (id: string) => {
      if (id.startsWith('ex:')) {
        const p = existing.find((x) => `ex:${x.id}` === id)!;
        return `БАЗА: ${p.name}${p.code ? ` [${p.code}]` : ''}`;
      }
      const t = toCreate[Number(id.slice(4))]!;
      return `НОВАЯ: ${t.name}${t.code ? ` [${t.code}]` : ''}`;
    };
    for (const g of fuzzyGroups) console.log(`  ~ ${g.ids.map(labelOf).join('  ↔  ')}`);
    console.log('');
  }

  if (!APPLY) {
    console.log('DRY-RUN: изменений не внесено. Запусти с --apply после подтверждения владельцем.');
    return;
  }

  // ── APPLY ──
  const { brandTypeId } = await ensureBrandInfra(a);
  let createdBrands = 0;
  for (const name of brandsToCreate) {
    const created = await createEntity(a, brandTypeId);
    if (!created.ok || !created.id) throw new Error(`Не удалось создать марку ${name}`);
    const set = await setEntityAttribute(a, created.id, 'name', name);
    if (!set.ok) throw new Error(`Не удалось сохранить марку ${name}: ${set.error ?? 'неизвестная ошибка'}`);
    brandIdByName.set(name, created.id);
    createdBrands += 1;
  }

  const idByPart = new Map<PartRow, string>();
  for (const m of matched) idByPart.set(m.part, m.existingId);
  let createdParts = 0;
  for (const t of toCreate) {
    const res = await createDirectoryPart({ name: t.name, ...(t.code ? { code: t.code } : {}) });
    if (res.ok) {
      idByPart.set(t, res.part.id);
      createdParts += 1;
    } else {
      const dup = String(res.error || '').match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
      if (dup?.[1]) idByPart.set(t, dup[1]);
      else throw new Error(`createDirectoryPart(${t.name}): ${res.error}`);
    }
  }

  let flagged = 0;
  let linksUpserted = 0;
  for (const part of PARTS) {
    const partId = idByPart.get(part);
    if (!partId) throw new Error(`нет id для ${part.name} [${part.code ?? ''}]`);
    const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: partId });
    if (!cur.ok) throw new Error(`part-spec get ${partId}: ${cur.error}`);
    const spec = cur.spec ?? { code: null, dimensions: [], brandLinks: [] };
    const byBrand = new Map<string, PartSpecBrandLink>();
    for (const link of spec.brandLinks) byBrand.set(String(link.engineBrandId ?? ''), link);
    let dirty = false;
    for (const brandName of part.brands) {
      const brandId = brandIdByName.get(brandName);
      if (!brandId) throw new Error(`нет id марки ${brandName}`);
      const prev = byBrand.get(brandId);
      if (prev?.inCompletenessAct && prev?.inDefectAct) continue;
      byBrand.set(brandId, {
        id: prev?.id ?? randomUUID(),
        engineBrandId: brandId,
        assemblyUnitNumber: prev?.assemblyUnitNumber ?? null,
        quantity: prev?.quantity ?? 1,
        inCompletenessAct: true,
        inDefectAct: true,
      });
      dirty = true;
      linksUpserted += 1;
    }
    if (dirty) {
      const upd = await upsertWarehouseNomenclaturePartSpec({ nomenclatureId: partId, spec: { ...spec, brandLinks: [...byBrand.values()] } });
      if (!upd.ok) throw new Error(`part-spec update ${partId}: ${upd.error}`);
      flagged += 1;
    }
  }

  console.log(`APPLY готово: создано марок ${createdBrands}, создано деталей ${createdParts}, обновлено привязок/флагов у ${flagged} деталей (${linksUpserted} привязок).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
