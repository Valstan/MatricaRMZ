// Т3 (docs/plans/parts-articul-acts-2026-06.md): импорт базового списка деталей
// владельца (нормализованные данные — brain letter 2026-06-12-base-parts-list-data).
//
// Правила владельца:
//   1. Несколько сб-номеров у детали = НЕСКОЛЬКО деталей с одним названием.
//   2. Деталь без сб-номера — только название (артикул пуст).
//   3. Все детали привязываются ко ВСЕМ маркам двигателей.
//   4. Ключ дублей = пара (название, артикул) — Т1; fuzzy-совпадения с базой
//      идут в отчёт на ручной триаж, НЕ авто-решаются.
//   5. Секция 1 → галочка «акт комплектности», секция 2 → «акт дефектовки»
//      (флаги на привязке деталь↔марка, Т4).
//
// Запуск: corepack pnpm -F @matricarmz/backend-api warehouse:import-base-parts        (dry-run)
//         corepack pnpm -F @matricarmz/backend-api warehouse:import-base-parts --apply
//
// ⚠️-места из data-письма НЕ применяются молча: PENDING-позиции и кандидаты-маппинги
// секции 2 перечисляются в отчёте и ждут решения владельца (#025).
import { and, eq, isNull } from 'drizzle-orm';
import { directoryPartIdentityKey, groupDirectoryPartDuplicates } from '@matricarmz/shared';
import type { PartSpecBrandLink } from '@matricarmz/shared';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { attributeValues, entities, entityTypes, attributeDefs } from '../database/schema.js';
import {
  createDirectoryPart,
  getWarehouseNomenclaturePartSpec,
  listWarehouseNomenclaturePartSpecs,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';

const APPLY = process.argv.includes('--apply');

// ── Данные (нормализованы brain из docx владельца 2026-06-11) ──────────────────

type Section1Row = { name: string; codes: string[]; note?: string };

const SECTION1: Section1Row[] = [
  { name: 'Картер верхний', codes: ['3301-15-30'] },
  { name: 'Картер нижний', codes: ['3301-15-30'] },
  { name: 'Вал коленчатый', codes: ['3305-01-18', '3305-01-17'] },
  { name: 'Рубашка цилиндров правая', codes: ['303-03-11'] },
  { name: 'Рубашка цилиндров левая', codes: ['303-02-16'] },
  { name: 'Головка блока правая', codes: ['306-01-26', '306-01-20'] },
  { name: 'Головка блока левая', codes: ['306-02-26', '306-02-20'] },
  { name: 'Патрубок слива масла', codes: [] },
  { name: 'Насос топливный НК-10М', codes: ['327-00-62'] },
  { name: 'Насос топливный НК-12М', codes: ['327-00-47'] },
  { name: 'Насос топливоподкачивающий', codes: ['532-00-02'] },
  { name: 'Насос водяной', codes: ['411-00-35А', '411-00-48', '411-00-42'] },
  { name: 'Насос масляный', codes: ['3312-00-16', '3312-00-15', '3312-00-17'] },
  { name: 'ТФТО', codes: ['3329-00-13'] },
  { name: 'Маслоочиститель центробежный', codes: ['447-00', '447-00-1'] },
  { name: 'Фильтр масляный', codes: ['413-00-14', '413-00-15', '413-00-7', '413-00-10'] },
  { name: 'Датчик тахометра', codes: [] },
  { name: 'Привод', codes: ['303.01.сб.2'] },
  { name: 'Механизм отбора мощности', codes: ['306.01СБ'] },
  { name: 'Нагнетатель', codes: ['3338-401-10', '3338-401-6'] },
  { name: 'Генератор с муфтой привода', codes: ['3309-25-2'] },
  { name: 'Воздухораспределитель', codes: ['310-30А'] },
  // Решение владельца 2026-06-12: «118.01 сб.N-1» — часть НАЗВАНИЯ, «Сб.418-5x-29/31» — артикул.
  { name: 'Трубопровод выпускной левый 118.01 сб.2-1', codes: ['Сб.418-50-29/31'] },
  { name: 'Трубопровод выпускной правый 118.01 сб.3-1', codes: ['Сб.418-51-29/31'] },
  { name: 'Трубопровод впускной левый', codes: ['419-06-10', '419-06-7/сб.419-06-12'], note: '⚠️ слэш-токен цельный' },
  { name: 'Трубопровод впускной правый', codes: ['419-05-10', '419-05-7/сб.419-05-12'], note: '⚠️ слэш-токен цельный' },
  { name: 'Труба подвода масла к распредвалу правая', codes: ['320-32А', '320-32'] },
  { name: 'Труба подвода масла к распредвалу левая', codes: ['320-33А', '320-33'] },
  { name: 'Шланг от маслонасоса к маслоочистителю', codes: ['420-51', '420-51-7', '420-164-7', '3320-164-8'] },
  { name: 'Трубка подвода масла к топливному насосу', codes: ['420-183-6', '420-183-5'] },
  { name: 'Труба подвода масла к нагнетателю', codes: ['3320-268-1', '3320-273'] },
  { name: 'Труба для подвода масла к приводу генератора', codes: ['3320-161-4'] },
  { name: 'Трубопровод от маслонасоса к маслофильтру', codes: ['3320-372-4/11', '420-02-12/7'] },
  { name: 'Трубопровод от маслофильтра к главной магистрали', codes: ['3320-398'] },
  { name: 'Трубопровод водяной', codes: ['3321-00-19', '3321-00-16'] },
  { name: 'Трубопровод воздушного пуска', codes: ['322-00-4'] },
  // Решение владельца 2026-06-12: «комплект из 4 сб» — это 4 РАЗНЫЕ детали (на обе серии А и -4).
  { name: 'Трубопровод высокого давления', codes: ['323-33А', '323-34А', '323-35А', '323-36А', '323-33-4', '323-34-4', '323-35-4', '323-36-4'] },
  { name: 'Система суфлирования (корпус маслоотделителя)', codes: ['3342-184-2', '3342-184-1'] },
  { name: 'Крышка головки правая', codes: ['406-08-3', '306-08-8'] },
  { name: 'Крышка головки левая', codes: ['306-09-8', '306-09-10'] },
  { name: 'Крышка люка', codes: ['406-12-44'] },
];

// Секция 2 — галочка «акт дефектовки», только названия. Маппинги «другое написание
// той же детали» подтверждены владельцем 2026-06-12 и развёрнуты в канонические
// имена секции 1 (см. список ниже); «Генератор» и «Привод генератора с муфтой» —
// РАЗНЫЕ детали от «Генератор с муфтой привода» (решение владельца).
const SECTION2: string[] = [
  'Блок',
  'Головка',
  'Гильза',
  'Резина',
  'Кольцо газостыка',
  'Поршень',
  'Поршневое кольцо',
  'Форсунка',
  'Картер верхний',
  'Картер нижний',
  'Вал коленчатый',
  'Рубашка цилиндров правая',
  'Рубашка цилиндров левая',
  'Головка блока правая',
  'Головка блока левая',
  'БНК',
  // Маппинги владельца (2026-06-12): канонические имена вместо разговорных написаний.
  'Насос топливный НК-10М', // «Насос топливный» (без модели) → флаг на обе
  'Насос топливный НК-12М',
  'Маслоочиститель центробежный', // «МЦ-1»
  'Механизм отбора мощности', // «МОМ»
  'Система суфлирования (корпус маслоотделителя)', // «Сапун»
  'Шланг от маслонасоса к маслоочистителю', // «Трубопровод масляный шланг от насоса к МЦ»
  'Трубопровод от маслонасоса к маслофильтру', // «Трубопровод масляный шланг от насоса к МАФ»
  'Трубопровод воздушного пуска', // «Трубопровод воздухопуска»
  'Трубопровод высокого давления',
  // Решение владельца: это РАЗНЫЕ детали, не варианты «Генератор с муфтой привода».
  'Генератор',
  'Привод генератора с муфтой',
  'Насос водяной',
  'Насос масляный',
  'ТФТО',
  'Фильтр масляный',
  'Датчик тахометра',
  'Привод',
  'Нагнетатель',
  'Воздухораспределитель',
  // Длинные имена — решение владельца по выпускным (118.01 сб.N-1 — часть названия).
  'Трубопровод выпускной левый 118.01 сб.2-1',
  'Трубопровод выпускной правый 118.01 сб.3-1',
  'Трубопровод впускной левый',
  'Трубопровод впускной правый',
  'Трубопровод водяной',
  'Патрубок слива масла',
  'Крышка головки правая',
  'Крышка головки левая',
  'Крышка люка',
];

// Решение владельца 2026-06-12 (политика для существующих деталей с тем же именем БЕЗ артикула):
// имя с ОДНИМ артикулом — присвоить артикул существующей детали (история/остатки сохраняются);
// с НЕСКОЛЬКИМИ — существующей дать первый артикул, остальные создать новыми.
// Применяется только при точном совпадении нормализованного имени; fuzzy-похожие
// (опечатки, «Картер» vs «Картер верхний») остаются в отчёте на ручной триаж (модуль Т2).

// ── Импорт ──────────────────────────────────────────────────────────────────────

function normName(s: string): string {
  return directoryPartIdentityKey(s, null).split('|')[0] ?? '';
}

async function loadBrands(): Promise<Array<{ id: string; name: string }>> {
  const typeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, 'engine_brand'), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id;
  if (!typeId) throw new Error('тип engine_brand не найден');
  const defRows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId), eq(attributeDefs.code, 'name'), isNull(attributeDefs.deletedAt)))
    .limit(1);
  const nameDefId = defRows[0]?.id;
  if (!nameDefId) throw new Error('атрибут name марки не найден');
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
    return { id: String(r.id), name };
  });
}

async function main() {
  console.log(`=== Импорт базового списка деталей — ${APPLY ? 'APPLY' : 'DRY-RUN'} ===\n`);

  const brands = await loadBrands();
  console.log(`Марок двигателей (живых): ${brands.length} — ${brands.map((b) => b.name).join(', ')}\n`);

  const listed = await listWarehouseNomenclaturePartSpecs();
  if (!listed.ok) throw new Error(`не удалось загрузить детали: ${listed.error}`);
  const existing = listed.rows.map((r) => ({ id: r.id, name: r.name, code: r.code ?? null }));
  const existingByKey = new Map(existing.map((p) => [directoryPartIdentityKey(p.name, p.code), p]));
  const existingByName = new Map<string, Array<{ id: string; name: string; code: string | null }>>();
  for (const p of existing) {
    const key = normName(p.name);
    const list = existingByName.get(key);
    if (list) list.push(p);
    else existingByName.set(key, [p]);
  }

  // Целевые детали секции 1: каждый сб-номер = отдельная деталь.
  type Target = { name: string; code: string | null; completeness: boolean; defect: boolean; note?: string };
  const targets = new Map<string, Target>();
  for (const row of SECTION1) {
    const codes = row.codes.length ? row.codes : [null];
    for (const code of codes) {
      const key = directoryPartIdentityKey(row.name, code);
      const prev = targets.get(key);
      targets.set(key, {
        name: row.name,
        code,
        completeness: true,
        defect: prev?.defect ?? false,
        ...(row.note ? { note: row.note } : {}),
      });
    }
  }
  // Секция 2: флаг дефектовки на ВСЕ детали с этим названием (любой артикул);
  // если по названию нет ни существующих, ни целевых — создаётся деталь без артикула.
  const defectOnlyCreates: string[] = [];
  for (const name of SECTION2) {
    const nameKey = normName(name);
    let touched = false;
    for (const t of targets.values()) {
      if (normName(t.name) === nameKey) {
        t.defect = true;
        touched = true;
      }
    }
    const existingSame = existingByName.get(nameKey) ?? [];
    if (existingSame.length > 0) touched = true;
    if (!touched) {
      const key = directoryPartIdentityKey(name, null);
      if (!targets.has(key)) {
        targets.set(key, { name, code: null, completeness: false, defect: true });
        defectOnlyCreates.push(name);
      }
    }
  }

  // In-place присвоение артикула (решение владельца): существующая деталь с тем же
  // нормализованным именем и ПУСТЫМ артикулом получает ПЕРВЫЙ артикул этого имени
  // из списка; остальные артикулы имени создаются новыми деталями.
  const adoptions: Array<{ existingId: string; name: string; code: string; targetKey: string }> = [];
  const adoptedKeys = new Set<string>();
  const adoptedExistingIds = new Set<string>();
  const namesInOrder: string[] = [];
  const seenNames = new Set<string>();
  for (const t of targets.values()) {
    const nk = normName(t.name);
    if (!seenNames.has(nk)) {
      seenNames.add(nk);
      namesInOrder.push(nk);
    }
  }
  for (const nk of namesInOrder) {
    const nameTargets = [...targets.entries()].filter(([, t]) => normName(t.name) === nk && t.code != null);
    if (!nameTargets.length) continue;
    const emptyCodeExisting = (existingByName.get(nk) ?? []).filter(
      (p) => !String(p.code ?? '').trim() && !adoptedExistingIds.has(p.id),
    );
    const candidate = emptyCodeExisting[0];
    if (!candidate) continue;
    const [firstKey, firstTarget] = nameTargets.find(([key]) => !existingByKey.has(key)) ?? [];
    if (!firstKey || !firstTarget) continue;
    adoptions.push({ existingId: candidate.id, name: firstTarget.name, code: String(firstTarget.code), targetKey: firstKey });
    adoptedKeys.add(firstKey);
    adoptedExistingIds.add(candidate.id);
  }

  // Классификация: уже есть / присвоить существующей / создать.
  const toCreate: Target[] = [];
  const matched: Array<{ target: Target; existingId: string }> = [];
  for (const [key, t] of targets) {
    const ex = existingByKey.get(key);
    if (ex) matched.push({ target: t, existingId: ex.id });
    else if (!adoptedKeys.has(key)) toCreate.push(t);
  }

  // Fuzzy-проверка новых против существующей базы (ручной триаж, не авто-решение).
  // Существующим, которым присваивается артикул, подставляем будущий код — иначе
  // отчёт шумит парами «БАЗА без артикула ↔ НОВАЯ с другим», которые после apply
  // станут легальной семьёй (одно имя, разные артикулы).
  const adoptionCodeByExistingId = new Map(adoptions.map((a) => [a.existingId, a.code]));
  const fuzzyInput = [
    ...existing.map((p) => ({ id: `ex:${p.id}`, name: p.name, code: adoptionCodeByExistingId.get(p.id) ?? p.code })),
    ...toCreate.map((t, i) => ({ id: `new:${i}`, name: t.name, code: t.code })),
  ];
  const fuzzyGroups = groupDirectoryPartDuplicates(fuzzyInput).filter(
    (g) => g.kind === 'fuzzy' && g.ids.some((id) => id.startsWith('new:')) && g.ids.some((id) => id.startsWith('ex:')),
  );

  // Отчёт.
  console.log(`Деталей в базе: ${existing.length}`);
  console.log(`Целевых позиций списка: ${targets.size}`);
  console.log(`— уже есть (совпала пара название+артикул): ${matched.length}`);
  console.log(`— присвоение артикула существующей детали без артикула: ${adoptions.length}`);
  console.log(`— будет создано: ${toCreate.length}${defectOnlyCreates.length ? ` (из них только-дефектовка без артикула: ${defectOnlyCreates.join(', ')})` : ''}`);
  console.log(`Флаги: «акт комплектности» → ${[...targets.values()].filter((t) => t.completeness).length} позиций, «акт дефектовки» → ${[...targets.values()].filter((t) => t.defect).length} позиций; секция 2 дополнительно проставит дефектовку на существующие одноимённые детали.`);
  console.log(`Привязка: каждая позиция → все ${brands.length} марок (существующие привязки и узлы сборки сохраняются).\n`);

  if (adoptions.length) {
    console.log('Присвоение артикула существующим деталям (история/остатки сохраняются):');
    for (const a of adoptions) {
      const ex = existing.find((p) => p.id === a.existingId)!;
      console.log(`  ± «${ex.name}» ← артикул [${a.code}]`);
    }
    console.log('');
  }
  if (toCreate.length) {
    console.log('Создаваемые детали:');
    for (const t of toCreate) console.log(`  + ${t.name}${t.code ? ` [${t.code}]` : ' [без артикула]'}${t.completeness ? ' ✓компл' : ''}${t.defect ? ' ✓дефект' : ''}${t.note ? `  ${t.note}` : ''}`);
    console.log('');
  }
  if (fuzzyGroups.length) {
    console.log('⚠️ Fuzzy-кандидаты (похожие на уже существующие — проверь руками, импорт их НЕ объединяет):');
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
  let created = 0;
  let adopted = 0;
  let flagged = 0;
  const idByTargetKey = new Map<string, string>();
  for (const { target, existingId } of matched) idByTargetKey.set(directoryPartIdentityKey(target.name, target.code), existingId);
  for (const a of adoptions) {
    const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: a.existingId });
    if (!cur.ok) throw new Error(`part-spec get ${a.existingId}: ${cur.error}`);
    const spec = cur.spec ?? { code: null, dimensions: [], brandLinks: [] };
    const upd = await upsertWarehouseNomenclaturePartSpec({ nomenclatureId: a.existingId, spec: { ...spec, code: a.code } });
    if (!upd.ok) throw new Error(`артикул-присвоение ${a.existingId}: ${upd.error}`);
    idByTargetKey.set(a.targetKey, a.existingId);
    adopted += 1;
  }
  for (const t of toCreate) {
    const res = await createDirectoryPart({ name: t.name, code: t.code });
    if (!res.ok) {
      const dup = String(res.error || '').match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
      if (dup?.[1]) {
        idByTargetKey.set(directoryPartIdentityKey(t.name, t.code), dup[1]);
        continue;
      }
      throw new Error(`createDirectoryPart(${t.name}): ${res.error}`);
    }
    idByTargetKey.set(directoryPartIdentityKey(t.name, t.code), res.part.id);
    created += 1;
  }

  // Дефект-флаг секции 2 на существующие одноимённые детали (вне целевых ключей).
  const extraDefectIds = new Map<string, { name: string }>();
  for (const name of SECTION2) {
    for (const p of existingByName.get(normName(name)) ?? []) {
      const key = directoryPartIdentityKey(p.name, p.code);
      if (!targets.has(key)) extraDefectIds.set(p.id, { name: p.name });
    }
  }

  const applyFlags = async (partId: string, completeness: boolean, defect: boolean) => {
    const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: partId });
    if (!cur.ok) throw new Error(`part-spec get ${partId}: ${cur.error}`);
    const spec = cur.spec ?? { code: null, dimensions: [], brandLinks: [] };
    const byBrand = new Map<string, PartSpecBrandLink>();
    for (const link of spec.brandLinks) byBrand.set(String(link.engineBrandId ?? ''), link);
    for (const b of brands) {
      const prev = byBrand.get(b.id);
      byBrand.set(b.id, {
        id: prev?.id ?? randomUUID(),
        engineBrandId: b.id,
        assemblyUnitNumber: prev?.assemblyUnitNumber ?? null,
        quantity: prev?.quantity ?? 1,
        ...(completeness || prev?.inCompletenessAct ? { inCompletenessAct: true } : {}),
        ...(defect || prev?.inDefectAct ? { inDefectAct: true } : {}),
      });
    }
    const upd = await upsertWarehouseNomenclaturePartSpec({
      nomenclatureId: partId,
      spec: { ...spec, brandLinks: [...byBrand.values()] },
    });
    if (!upd.ok) throw new Error(`part-spec update ${partId}: ${upd.error}`);
    flagged += 1;
  };

  for (const [key, t] of targets) {
    const id = idByTargetKey.get(key);
    if (!id) throw new Error(`нет id для ${t.name} [${t.code ?? ''}]`);
    await applyFlags(id, t.completeness, t.defect);
  }
  for (const [id] of extraDefectIds) await applyFlags(id, false, true);

  console.log(`APPLY готово: создано деталей ${created}, артикул присвоен существующим ${adopted}, обновлено привязок/флагов у ${flagged} деталей.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
