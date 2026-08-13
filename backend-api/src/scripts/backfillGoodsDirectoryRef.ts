import 'dotenv/config';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { directoryGoods, erpNomenclature } from '../database/schema.js';
import { upsertWarehouseNomenclature } from '../services/warehouseService.js';

// Ф0 плана tools-catalog-unify-2026-08-13: восстановление directory_ref_id у товарных
// позиций номенклатуры.
//
// Почему пусто: миграция 0045 создала строки directory_goods из EAV-сущностей, чтобы ссылка
// РАЗРЕШАЛАСЬ при будущих upsert'ах, но уже существующие строки erp_nomenclature не трогала.
// У деталей обратную ссылку проставили точечными скриптами (linkNomenclatureToPart и др.),
// у товаров/инструмента/услуг — нет. Следствие: «Снабжение → Учёт инструментов» отбирает
// субъекты по непустому directoryRefId и показывает пустой список.
//
// Сопоставление — по ТОЧНОМУ имени и только там, где имя уникально с ОБЕИХ сторон.
// Неоднозначное (одно имя у нескольких карточек) не угадывается: скрипт печатает такие
// случаи и оставляет их владельцу. Молча выбрать «первую попавшуюся» — значит привязать
// движения товара не к той карточке.
//
// Запись идёт через upsertWarehouseNomenclature — канонический путь (PG + подпись в ledger,
// откуда тянут клиенты). Прямой UPDATE подписал бы PG мимо ledger, и клиенты остались бы
// со старой строкой (та же грабля, что в linkNomenclatureToPart).
//
// Запуск:
//   pnpm -F @matricarmz/backend-api warehouse:backfill-goods-directory-ref
//   pnpm -F @matricarmz/backend-api warehouse:backfill-goods-directory-ref -- --apply

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function nameKey(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replaceAll('ё', 'е').replaceAll(/\s+/g, ' ');
}

/** Имена, встречающиеся ровно один раз. Остальные — неоднозначные, их не трогаем. */
function uniqueByName<T extends { name: string | null }>(rows: T[]): Map<string, T> {
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = nameKey(row.name);
    if (!key) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const out = new Map<string, T>();
  for (const [key, bucket] of buckets) {
    if (bucket.length === 1 && bucket[0]) out.set(key, bucket[0]);
  }
  return out;
}

async function main() {
  const apply = hasFlag('--apply');

  const targets = await db
    .select()
    .from(erpNomenclature)
    .where(and(inArray(erpNomenclature.directoryKind, ['good', 'product']), isNull(erpNomenclature.directoryRefId), isNull(erpNomenclature.deletedAt)))
    .limit(20_000);

  const sources = await db
    .select({ id: directoryGoods.id, name: directoryGoods.name })
    .from(directoryGoods)
    .where(isNull(directoryGoods.deletedAt))
    .limit(20_000);

  console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`товарных позиций без ссылки: ${targets.length}`);
  console.log(`карточек directory_goods: ${sources.length}`);

  if (targets.length === 0) {
    console.log('Нечего восстанавливать.');
    return;
  }

  const uniqueTargets = uniqueByName(targets.map((r) => ({ ...r, name: r.name })) as Array<typeof targets[number]>);
  const uniqueSources = uniqueByName(sources);

  const linked: Array<{ id: string; code: string; name: string; refId: string }> = [];
  const ambiguous: Array<{ id: string; code: string; name: string; why: string }> = [];
  const unmatched: Array<{ id: string; code: string; name: string }> = [];

  for (const row of targets) {
    const key = nameKey(row.name);
    const rowId = String(row.id);
    const info = { id: rowId, code: String(row.code ?? ''), name: String(row.name ?? '') };
    if (!key) {
      unmatched.push(info);
      continue;
    }
    if (!uniqueTargets.has(key)) {
      ambiguous.push({ ...info, why: 'имя встречается у нескольких позиций номенклатуры' });
      continue;
    }
    const source = uniqueSources.get(key);
    if (!source) {
      const anySource = sources.some((s) => nameKey(s.name) === key);
      if (anySource) ambiguous.push({ ...info, why: 'имя встречается у нескольких карточек directory_goods' });
      else unmatched.push(info);
      continue;
    }
    linked.push({ ...info, refId: String(source.id) });
  }

  console.log(`\nоднозначно сопоставлено: ${linked.length}`);
  console.log(`неоднозначно (не трогаем): ${ambiguous.length}`);
  console.log(`без пары в справочнике: ${unmatched.length}`);

  for (const row of ambiguous) console.log(`  ~ ${row.code || '(без кода)'} «${row.name}» — ${row.why}`);
  for (const row of unmatched) console.log(`  ? ${row.code || '(без кода)'} «${row.name}» — карточка-источник не найдена`);

  if (!apply) {
    console.log('\nDRY-RUN: ничего не записано. Повторить с --apply.');
    return;
  }

  let written = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const item of linked) {
    const rows = await db.select().from(erpNomenclature).where(eq(erpNomenclature.id, item.id as any)).limit(1);
    const current = rows[0];
    if (!current) {
      failures.push({ id: item.id, error: 'строка исчезла между чтением и записью' });
      continue;
    }
    // Upsert пишет строку целиком — эхо всех полей, иначе неуказанные обнулятся.
    const result = await upsertWarehouseNomenclature({
      id: item.id,
      code: String(current.code ?? ''),
      sku: current.sku ?? null,
      name: String(current.name ?? ''),
      itemType: String(current.itemType ?? 'material'),
      category: current.category ?? null,
      directoryKind: current.directoryKind ?? null,
      directoryRefId: item.refId,
      groupId: current.groupId ? String(current.groupId) : null,
      unitId: current.unitId ? String(current.unitId) : null,
      barcode: current.barcode ?? null,
      minStock: current.minStock ?? null,
      maxStock: current.maxStock ?? null,
      defaultBrandId: current.defaultBrandId ? String(current.defaultBrandId) : null,
      isSerialTracked: current.isSerialTracked === true,
      defaultWarehouseId: current.defaultWarehouseId ?? null,
      specJson: current.specJson ?? null,
      componentTypeId: current.componentTypeId ?? null,
      isActive: current.isActive !== false,
    });
    if (!result.ok) {
      failures.push({ id: item.id, error: String(result.error) });
      continue;
    }
    written += 1;
  }

  console.log(`\nзаписано: ${written} из ${linked.length}`);
  for (const f of failures) console.log(`  ! ${f.id} — ${f.error}`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
