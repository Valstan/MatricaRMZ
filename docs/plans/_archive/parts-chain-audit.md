# Parts-chain audit — единый источник истины (деталь от разборки до сборки)

> Директива brain `2026-06-06-parts-chain-audit-single-source-of-truth` (mandate). Прямое продолжение `bom-parts-into-engine-brand-lists` и Phase 3.
> Подход: **АУДИТ (A, read-only) → РЕМЕДИАЦИЯ (B, синхронно с Phase 3) → ВЕРИФИКАЦИЯ (C, CDP end-to-end)**.
> Статус: **этап A завершён 2026-06-06** (карта ниже, заземлена на прод-данных). Этапы B/C — отдельной ниткой, синхронно с Phase 3.7.

## Цель (формулировка владельца)

У детали — **один источник истины** (одна номенклатурная сущность `erp_nomenclature.id`) на каждом этапе движения по заводу: `разборка → дефектовка → приход → наряд → сборка`. Ноль параллельных списков, не завязанных на номенклатуру; ноль дублей в статистике/прогнозе. Программа однозначно понимает «эта деталь есть/нет, отремонтирована, ушла в сборку, снята с двигателя X».

---

## A. Карта keyspaces (прод-данные, снимок 2026-06-06)

| Keyspace | Где живёт | Активно | Роль в цепочке |
|---|---|---|---|
| **nomenclature** | `erp_nomenclature.id` | **637** | 🟢 ПЕРВИЧНЫЙ. Склад (`erp_reg_stock_balance` 31, `erp_reg_stock_movements` 43 — оба по `nomenclature_id`), BOM-строки (`erp_engine_assembly_bom_lines.component_nomenclature_id`, 102), разборка, приход, двигатели (`erp_engine_instances.nomenclature_id`) |
| **directory_parts** | `directory_parts.id` | **186** | Спецификация детали (code/template/dimensions/metadata) + `brand_links_json` (83 непустых) |
| **part EAV** «Деталь» | `entities` type=part | **186** | Legacy parts. 1:1 зеркало `directory_parts` (тот же id при `createPart`) |
| **part_engine_brand EAV** «Связь деталь↔марка» | `entities` type=part_engine_brand | **718** связей → **87** деталей / **34** марки | «Список деталей марки». Источник dual-write, атрибуты: `part_id`, `engine_brand_id`, `assembly_unit_number`, `quantity` |
| **engine_brand** | EAV «Марка двигателя» **37** ↔ `directory_engine_brands` **37** | 37/37 | Два keyspace для марки (id-1:1) |
| **engine** | EAV «Двигатель» | **1611** | `erp_engine_instances` = **0** (мёртв; двигатели — в EAV) |
| 💀 **part_cards** | `erp_part_cards` 0 / `erp_reg_part_usage` 0 / `erp_reg_stock_balance.part_card_id` 0 | **0** | Фантомная схема (серийный учёт деталей), не используется на проде |
| 💀 **nomencl↔brand** | `erp_nomenclature_engine_brand` | **0** | Фантом, не используется |

### Чтение по этапам (enumerate-consumers, рефлекс #022)

| Этап | Слой / точка | Keyspace | Читает из |
|---|---|---|---|
| **Разборка** | `EngineDismantlePreviewDialog.tsx` (заморожена 2026-05-26) | nomenclature | `assemblyBomList` → `component_nomenclature_id`; приход документом по `nomenclatureId` |
| **Дефектовка** | `RepairChecklistPanel.tsx:520-533,808-826` | directory_parts (+ brand_links) | `listAllPartSpecs({engineBrandId})`; строки ключуются текст-сигнатурой `(name, part_number)` (G3) |
| **Приход** | `StockDocumentDetailsPage.tsx:248-306`; `warehouseService.ts:938-1051` | nomenclature | `nomenclatureList`; документ-строки по `nomenclatureId`. On-the-fly создание → `nomenclatureDirectoryPartCreate` возвращает directory id + fallback-lookup nomenclature (G1/race) |
| **Наряд** | `WorkOrderDetailsPage.tsx`; `workOrderClosingService.ts:96-139` | directory_parts → nomenclature | `workLine.partId` используется **напрямую как `nomenclatureId`** без трансляции (G1) |
| **Сборка / BOM** | `EngineAssemblyBomPage.tsx`; `warehouseBomService.ts:140-200`; `bomBrandPartSync.ts` | nomenclature (компонент) + engine_brand (связь) | BOM-строки по `component_nomenclature_id`; BOM↔марка через `erp_engine_assembly_bom_brand_links` (21) |
| **Прогноз** | `warehouseForecastService.ts:47-58,423-452`; `shared/assemblyForecast.ts` | nomenclature (только) | `erp_reg_stock_balance` + BOM-kits по `nomenclatureId`. Single-source — но двоит при дублях номенклатуры (G2) |
| **Отчёты/статистика** | `routes/reports.ts` (generic EAV-render); счётчики деталей марки — UI-слой | смешанный | brand-summary читает directory (`listAllPartSpecs`); EAV-список (718) ≠ directory-зеркало (83) — G4 |

---

## Разрывы (заземлены на данных + коде)

### 🔴 G1 — две конвенции моста part↔nomenclature
- **159** деталей: `directory_parts.id == erp_nomenclature.id` (конвенция Phase 2/3).
- **27** деталей: `id ≠ id`, мост только через `erp_nomenclature.directory_ref_id` (конвенция backfill bom-parts; все 27 достижимы `directory_ref_id=1`).
- **Последствие:** `workOrderClosingService.ts:96-139` берёт `workLine.partId` напрямую как `nomenclatureId`. Для 159 деталей совпадает, для **27** — указывает в несуществующую/чужую номенклатуру. Аналогичный риск в on-the-fly создании при приходе (fallback-lookup, гонка).
- **Ремедиация:** свести к одной конвенции (id-тождество) — слить 27 «backfill»-деталей с их nomenclature по `directory_ref_id`, либо ввести явную трансляцию `directory_parts.id → nomenclature.id` во всех писателях. Предпочтительно — единый id (часть Phase 3.7).

### 🔴 G2 — дубли номенклатуры → двойной счёт
- **34** группы одноимённых строк, **56** лишних строк в `erp_nomenclature`.
- Backfill bom-parts создал **обобщённые** «Гильза»/«Головка»/«Картер»/«Кольцо»/«Рубашка цилиндров» поверх конкретных каталожных (`Гильза 303-07-2 150,0-150,10…` ×11, `Картер нижний` ×2, `Поршень` ×2 …).
- **Последствие:** прогноз/статистика читают nomenclature → одна физическая деталь под несколькими id двоится **by construction**.
- **Ремедиация:** дедуп. **Требует доменного решения владельца** — что именно одна и та же физическая деталь (обобщённое имя vs конкретный артикул — это может быть и группа-родитель, и дубль). Скрипт `warehouse:merge-duplicate-part` (dry-run/`--apply`, подписанные пути) уже есть.

### 🟡 G3 — дефектовка ключует строки текстом, не id
- `RepairChecklistPanel.tsx:242-256` — сигнатура `(part_name, part_number)`. Ручной ввод без выбора из списка → строка без `partId`; при перезагрузке list-sync перетирает строку, если текст-сигнатура совпала с brand-managed.
- **Ремедиация:** хранить `part.id` (nomenclature id) на brand-managed строках, сохранять через merge; запретить безыдентификаторный ручной ввод либо создавать деталь на лету с id.

### 🟡 G4 — неполное зеркало brand-links
- EAV «список деталей марки» = **87** деталей; зеркало `directory.brand_links_json` = **83**. Расхождение 4 → списки марки различаются в зависимости от keyspace потребителя.
- Dual-write (`mirrorPartBrandLinksToDirectory`) — best-effort, не транзакционный.
- **Ремедиация:** после миграции читателей на единый источник мост снимается (Phase 3.7); до того — реконсиляция (backfill зеркала до полного покрытия) или перевод оставшихся читателей EAV на directory.

### 🟢 G5 — мёртвые keyspace-схемы (ловушки)
- `erp_part_cards`, `erp_reg_part_usage`, `erp_nomenclature_engine_brand`, `erp_engine_instances` — 0 строк, но присутствуют в схеме/типах. Риск: будущий код подцепит «второй» keyspace.
- **Ремедиация:** задокументировать как мёртвые; снос — отдельная низкоприоритетная нитка (вне scope директивы, но в реестр).

---

## B. Ремедиация (синхронно с Phase 3.7) — план

> Делать **на сошедшейся модели**, не плодить данные, которые миграция реконсилит. Прод-мутации — рефлекс #025/G29: подтверждать затрагиваемый набор в том же ходе, `log_statement='mod'`/ledger на время, бэкап до `--apply`.

1. **G2 дедуп** (первым — снимает двойной счёт): владелец размечает дубли → `warehouse:merge-duplicate-part --apply` по подтверждённому списку. Документировать row counts в PR.
2. **G1 единый мост**: слить 27 «backfill»-деталей к id-тождеству ИЛИ ввести трансляцию `directory_parts.id→nomenclature.id` в писателях наряда/прихода. Связать с Phase 3.7 (снос dual-write моста `mirrorPartFieldsToDirectory`/`mirrorPartBrandLinksToDirectory` + миграция операционных скриптов EAV→directory).
3. **G4 зеркало**: после перевода читателей на единый источник — снять мост; до того — backfill зеркала до 87/87.
4. **G3 дефектовка**: id-ключевание строк.
5. **G5**: реестр мёртвых схем.

## C. Верификация (доказать, не на глаз)

- CDP end-to-end (рефлекс #013, verifier-electron): прогнать **одну** деталь `разборка → приход → ремонт → сборка`; ассертить **единую** nomenclature-сущность на всех экранах; прогноз/статистика не двоят.
- Перепроверить исходный bom-parts кейс на сошедшейся модели (деталь в BOM, но не приходуется при разборке) — как частный случай единого источника.

## Критерии приёмки (из директивы)

1. ✅ Карта-аудит: источники + keyspaces + потребители (вкл. прогноз) + разрывы + не-завязанные списки — **этот документ**.
2. ⏳ После ремедиации: одна физ. деталь = один nomenclature-id на всех этапах; нет параллельных keyspace для той же сущности.
3. ⏳ Сквозной CDP-прогон показывает единую сущность; прогноз/статистика без дублей.
4. ⏳ Исходный bom-parts гейт перепроверен на сошедшейся модели.

## Открытые замеры (добить в этапе B)
- Полный список 34 групп дублей + 27 backfill-деталей с предложением «слить/оставить» для разметки владельцем.
