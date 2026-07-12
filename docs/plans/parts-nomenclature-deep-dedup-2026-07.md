# Глубокая де-дупликация directory_parts ↔ erp_nomenclature (DET-зеркала)

**Статус:** Ф0 ✅ (прод-инвентаризация) · **вопросы владельцу отвечены 2026-07-12** · Ф1 ✅ (код, CDP 7/7) · Ф2 — скрипт готов, **прогон заблокирован раскатом клиентов** (см. Ф2). Прод-данные пока НЕ тронуты.

**Решения владельца (2026-07-12):** (1) канон имени — **складская карточка** (`erp_nomenclature`, консистентно с read-through #648; reconcile как есть); (2) остаточные DET-/NM-коды — **обнулить** (пустой артикул честнее синтетики); (3) удаление карточки — **гасит обе стороны** (симметричный soft-delete пары).

## Context (зачем)

Пара «деталь» = две строки с одним UUID: `directory_parts` (спека: dimensions/brandLinks/metadataJson) + `erp_nomenclature` (складская карточка: code/name/unit/group). Техдолг из PENDING §Техдолг: **DET-зеркала в данных** — синтетические коды `DET-<id8>` вместо реальных артикулов, исторические ref-only пары (id ≠ ref_id), расхождение name/code при раздельной правке. Симптом findability снят #656 (наряд ищет по реальному `code`), но мусор в данных остаётся и **продолжает генерироваться**.

## Что выяснила разведка (ключевое)

### Модель связи
- **Новые пары id-тождественны by construction:** `createDirectoryPart` → `ensurePartNomenclatureMirror` передаёт `id: part.id`, `directoryRefId: id` ([warehouseService.ts:808-833](../../backend-api/src/services/warehouseService.ts)). `directory_ref_id` для них избыточен (указывает на себя).
- **Legacy ref-only пары** (id ≠ ref_id, «конвенция G1», ~27 строк на момент написания unify-скрипта) — лечатся существующим `warehouse:unify-part-id-convention[:apply]` ([unifyPartIdConvention.ts](../../backend-api/src/scripts/unifyPartIdConvention.ts)); внешних ссылок на ref-id нет, кроме отмирающего EAV `part_engine_brand.part_id`.

### DET-коды — не только legacy, генерятся и сейчас
1. `ensurePartNomenclatureMirror` — [warehouseService.ts:816](../../backend-api/src/services/warehouseService.ts): каждый `createDirectoryPart` без артикула получает `DET-<id8>`.
2. `mergeDirectoryParts` (dedupe) — [directoryPartsDedupeService.ts:485](../../backend-api/src/services/directoryPartsDedupeService.ts): survivor без кода получает `DET-`.
Признанный placeholder-паттерн: `reconcileNomenclatureDirectoryCodeName.ts:33` и `setCompletenessActFlags.ts:9` трактуют `^(DET|NM)-` как «неосмысленный артикул».

### Дыры раздельной записи (источники расхождений)
- `upsertWarehouseNomenclaturePartSpec` пишет только в `directory_parts` (:1845-1917); `upsertWarehouseNomenclature` — только в `erp_nomenclature` (:1445-…). Read-through JOIN (#648, :1935-1974) маскирует расхождение name/code на карточках марки/двигателя, но одиночный `getWarehouseNomenclaturePartSpec` (:1821-1843) читает голый `directory_parts`.
- **`deleteWarehouseNomenclature` (:1727-1773) гасит только зеркало** — парная `directory_parts` живёт → сироты + duplicate-капкан при пере-создании той же детали (воспроизведено вживую CDP-смоуком 2026-07-12: create → `HTTP 400 duplicate part exists`, а поиск деталь не видит).

### Инварианты для любого data-скрипта
- FK по **nomenclature_id (== dp.id)**: `erp_reg_stock_balance`, `erp_reg_stock_movements` (**hashchain — не переподписывать**), `erp_engine_assembly_bom_lines`, `erp_document_lines` (+ `__part_id` в мета актов), `operations`.
- `erp_nomenclature.code` глобально уникален (включая deleted; partial-uq 0066 неполон) — reconcile пропускает занятые коды.
- Одна транзакция; ledger/sync — после commit (паттерн mergeDirectoryParts :444-448).

### Существующая оснастка (переиспользовать, не писать заново)
`warehouse:audit-parts-mirror` (read-only аудит orphans A/B/C) · `warehouse:fix-parts-mirror` (чинит A/C) · `warehouse:backfill-orphan-part-nomenclature` (create-only зеркала) · `warehouse:unify-part-id-convention[:apply]` (G1 ref-only) · `warehouse:reconcile-code-name[:apply]` (сводит name, промоутит реальные артикулы поверх `DET-/NM-`) · `warehouse:directories-dry-run` (counts/collisions) · dedupe-сервис с UI (merge с repoint всех FK).

## План (фазы)

### Ф0 — прод-инвентаризация (read-only) — ✅ ВЫПОЛНЕНА 2026-07-12

Прогнано на проде (env по M30, только dry/чтение):

| Метрика | Значение |
|---|---|
| `erp_nomenclature` живых всего | **1352** |
| — с кодом `DET-%` | **123** |
| — с кодом `NM-%` | **22** (итого ~11% синтетики) |
| — `directory_kind='part'` | 705 |
| `directory_parts` живых | **842** |
| — без живого зеркала | **3** |
| — зеркало soft-deleted (duplicate-капкан) | **2** |
| Аудит A (entity part без dp) | 33 — у всех dp **soft-deleted** (legacy EAV-ось живее пары) |
| Аудит B (dp без entity) | 746 — **ожидаемо** (Phase 2a: новые детали не создают EAV entity) |
| Аудит C (битый directory_ref_id) | **0** |
| G1 ref-only пары (id≠ref_id) | **0** (вычищены ранее) |
| reconcile: расхождений id-identity | 101; чинимых имён **13**; code-promote **0**; коллизий **1** (картер `3301-15-30` — известная санкционированная пара) |

Выводы: (1) структурная связность уже здоровая (C=0, G1=0) — тяжесть долга не в связях, а в **синтетических кодах** (145 шт.) и **генераторе нового долга**; (2) code-promote=0 → у DET-строк реального артикула нет нигде — судьба решается вопросом №2, не скриптом; (3) духов duplicate-капкана всего 2+3 — точечная чистка. Побочная находка: `warehouse:directories-dry-run` **мёртв** (падает на снесённой `erp_part_cards` — скрипт древней фазы миграции; удалить при случае).

### Ф1 — стоп-кран генерации нового долга (код) — ✅ РЕАЛИЗОВАНА 2026-07-12

Реализация отклонилась от наброска в одном: **пустая строка `''` вместо NULL** — `code` NOT NULL в обеих схемах и типизирован `string` по всему стеку (NULL = миграция колонки + ломка типов синк-контракта); `''` даёт ту же честную семантику дёшево. Итог:
1. `ensurePartNomenclatureMirror` и dedupe-survivor: fallback `DET-` убран → `code = ''`.
2. **Partial unique на обеих сторонах:** сервер — миграция **0075** (`WHERE deleted_at is null AND code <> ''`); клиент — drizzle **0016** + `clientSchemaMigrations` **10→11** (`WHERE code <> '' AND deleted_at IS NULL`). Клиентский индекс заодно перестал быть глобальным — обезврежена мина merge-пары (survivor + soft-deleted loser делят код; сервер стал partial ещё в 0066, клиент — нет).
3. `deleteWarehouseNomenclature` гасит парную `directory_parts` (kind='part') — капкан «дух + duplicate» снят.
4. Скрипт Ф2 `warehouse:blank-synthetic-codes[:apply]` (dry/apply, идемпотентный): бланкинг DET-/NM- через `recordSyncChanges` (+ чистка `spec_json.article`), retire духов.

Verify: backend 385/385; CDP-смоук 7/7 (`_smoke-dedup-phase1.mjs`, gitignored): две детали без артикула сосуществуют на сервере, обе доезжают клиенту инкрементальным pull (= клиентская миграция 10→11 отработала), зеркало с пустым кодом (не DET-), delete→re-create того же имени ОК.

### Ф2 — чистка данных (dry-run → --apply + бэкап pg_dump)

**⚠️ Жёсткий порядок раската:** шаги 2-3 (бланкинг `''`-кодов) гнать **только после того, как ВСЕ клиенты обновились** до релиза с клиентской миграцией 0016/step-11 — на старом клиенте глобальный unique уронит pull второй же `''`-строкой. Проверка: web-admin → клиенты, `lastVersion` ≥ релиза с Ф1.

1. ~~`unify-part-id-convention --apply`~~ — не нужен (Ф0: ref-only = 0).
2. `reconcile-code-name --apply` — свод 13 имён (канон — карточка); code-promote 0 (Ф0). Не зависит от раската (имена, не коды) — можно раньше.
3. `blank-synthetic-codes --apply` — 123 DET- + 22 NM- → `''` (+ spec_json.article), retire 2 духов. **После раската.**
4. Коллизия картера `3301-15-30` (1 шт.) — санкционированная пара с общим артикулом, оставить (merge вручную только по решению владельца).
5. 3 dp без зеркала — `backfill-orphan-part-nomenclature --apply` (вернёт их в номенклатуру; они не удалялись — зеркало не создалось).

### Ф3 (опционально, отдельное решение) — конвергенция записи
Свести дуал-райт к одному пути (upsert спеки трогает и карточку, или наоборот) — уже частично сделано мерджем (#63: merge синхронизирует зеркало survivor). Поднимать только если Ф1+Ф2 не снимут боль. Размер: L, НЕ входит в текущий заход.

## Открытые вопросы владельцу (блокируют Ф1/Ф2)

1. **Семантика мерджа при чистке:** для пар с одинаковым смыслом, но разными name в двух сторах — чей вариант канон: складской карточки (`erp_nomenclature`, как в read-through #648) или спеки? (Предлагаю: карточки, консистентно с #648.)
2. **Остаточные DET-коды без реального артикула:** обнулить (пустой артикул честнее синтетики; поиск по коду их всё равно не находит) или оставить как есть?
3. **Поведение удаления карточки номенклатуры:** гасить и парную деталь (симметрия), или оставлять деталь живой (тогда — авто-реанимация зеркала при пере-создании по имени)? Сейчас — духи-сироты и duplicate-ошибка.

## Verification

Гейты обычные (build/typecheck/lint/backend vitest) + для Ф1 юнит на NULL-code mirror + CDP-смоук create-детали-без-артикула; для Ф2 — dry-run row-counts в теле PR, контрольный повторный прогон = 0 изменений (идемпотентность), бэкап pg_dump перед --apply (паттерн импортов).
