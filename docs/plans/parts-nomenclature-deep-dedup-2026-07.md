# Глубокая де-дупликация directory_parts ↔ erp_nomenclature (DET-зеркала)

**Статус:** план (разведка кода выполнена 2026-07-12, Explore-агент, все точки с file:line). Прод-данные НЕ тронуты. Старт — по OK владельца на §Открытые вопросы.

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

### Ф0 — прод-инвентаризация (read-only, без решений)
Прогнать на проде: `audit-parts-mirror`, `unify-part-id-convention` (dry), `reconcile-code-name` (dry), `directories-dry-run` + счётчики: сколько живых `DET-%`/`NM-%` кодов, сколько пар name-расхождений, сколько сирот directory_parts без зеркала (в т.ч. от deleteWarehouseNomenclature). Итог — таблица объёмов в этот план. **Без --apply.** Размер: S.

### Ф1 — стоп-кран генерации нового долга (код)
1. `ensurePartNomenclatureMirror`: при отсутствии артикула — **code = NULL** вместо `DET-` (проверить: уникальный индекс должен пропускать NULL; список/поиск уже живут с пустым кодом у legacy).
2. Тот же fallback в `mergeDirectoryParts` (:485).
3. `deleteWarehouseNomenclature`: соглашение по паре (см. вопрос №3 владельцу) — как минимум пометка/гашение парной directory_parts, чтобы не плодить duplicate-капкан.
Размер: S-M (риск: потребители, ожидающие непустой code — проверить рендеры/печать/выгрузки).

### Ф2 — чистка данных (по итогам Ф0, каждая пачка dry-run → --apply + бэкап)
1. `unify-part-id-convention --apply` — ref-only пары → id-тождество.
2. `reconcile-code-name --apply` — реальные артикулы поверх `DET-/NM-`, свод имён.
3. Остаточные `DET-` без реального артикула — по решению владельца (вопрос №2): NULL или оставить.
4. Сироты directory_parts (после deleteWarehouseNomenclature) — soft-delete по ревью-списку (паттерн emptyCardsService: анализ → ревью → удаление, без тихого авто).
Размер: M (операционный, поэтапный).

### Ф3 (опционально, отдельное решение) — конвергенция записи
Свести дуал-райт к одному пути (upsert спеки трогает и карточку, или наоборот) — уже частично сделано мерджем (#63: merge синхронизирует зеркало survivor). Поднимать только если Ф1+Ф2 не снимут боль. Размер: L, НЕ входит в текущий заход.

## Открытые вопросы владельцу (блокируют Ф1/Ф2)

1. **Семантика мерджа при чистке:** для пар с одинаковым смыслом, но разными name в двух сторах — чей вариант канон: складской карточки (`erp_nomenclature`, как в read-through #648) или спеки? (Предлагаю: карточки, консистентно с #648.)
2. **Остаточные DET-коды без реального артикула:** обнулить (пустой артикул честнее синтетики; поиск по коду их всё равно не находит) или оставить как есть?
3. **Поведение удаления карточки номенклатуры:** гасить и парную деталь (симметрия), или оставлять деталь живой (тогда — авто-реанимация зеркала при пере-создании по имени)? Сейчас — духи-сироты и duplicate-ошибка.

## Verification

Гейты обычные (build/typecheck/lint/backend vitest) + для Ф1 юнит на NULL-code mirror + CDP-смоук create-детали-без-артикула; для Ф2 — dry-run row-counts в теле PR, контрольный повторный прогон = 0 изменений (идемпотентность), бэкап pg_dump перед --apply (паттерн импортов).
