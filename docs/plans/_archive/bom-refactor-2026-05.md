# Рефакторинг цепочки BOM: серия релизов v1.21.0 → v1.22.0

## Context

Пользователь сообщает о хроническом баге в карточке BOM сборки двигателя ([EngineAssemblyBomDetailsPage.tsx](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx), 2175 строк):
- Открыл BOM → изменил строку → сохранил → закрыл → открыл: изменений нет
- Закрыл → открыл снова: всё на месте
- Снова открыл: опять ничего
- **Даже без правок** карточка при закрытии просит сохранить
- В строке «Картер» появляется stub-деталь «Гильза 303-07-22 150,11-150,18»

Четыре hotfix-релиза (v1.20.2–v1.20.5) фиксили симптомы (валидация componentType на backend, авто-backfill directory_parts), но корень проблемы — в **сложении** нескольких безобидных по отдельности слоёв клиента, backend и shared-логики. Пользователь требует комплексной проверки всей цепочки **Деталь → Двигатель → BOM → Склад → Прогноз сборки**.

### Корневые причины (выявлены в Phase 1 exploration)

1. **Race condition useEffect автогенерации stub-строк** ([EngineAssemblyBomDetailsPage.tsx:768-856](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L768)): после `refresh()` useEffect видит missing типы по схеме → мутирует `data` → `bomSnapshot` пересчитывается → **`isBomDirty=true` без участия пользователя**. После save может затереть пользовательский выбор stub-строкой.

2. **Backend пересчитывает `priority` по `sortOrder` схемы** ([warehouseBomService.ts:493](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L493) `schemaPriorityFor`). Клиент шлёт `priority: 100`, backend сохраняет `priority: <по схеме>`. `buildBomSnapshot` ([:226](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L226)) включает `priority`. После save → refresh приоритет другой → snapshot ≠ savedSnapshot → ложный dirty.

3. **`patchLine` не обновляет `componentType`** ([:635-658](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L635)). Пользователь выбирает картер в SearchSelect — `patchLine(idx, {componentNomenclatureId: ...})` обновляет только uuid. Тип строки остаётся прежним → backend сохранит «строка типа Гильза с uuid картера».

4. **Fallback на «первую попавшуюся» в pickStub** ([shared/warehouse.ts:764](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts#L764) + [warehouseBomService.ts:144](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L144)). Если нет engine-номенклатуры → возвращается первая активная = «Гильза 303-07-22» → попадает в реальную DB-строку как stub.

5. **`BOM_SKELETON_KNOWN_COMPONENT_TYPES` хардкод** ([shared/warehouse.ts:885](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts#L885)). Skeleton генерирует только 7 типов (sleeve/piston/ring/jacket/head/carter/other). Но backend validation требует **все** active типы схемы → новые кастомные типы не попадают в skeleton, backend отклоняет «BOM не сохранён».

6. **DB UNIQUE index** на `(bom_id, variant_group, component_nomenclature_id, component_type)` (migration 0043). Backend не делает pre-check дублей → INSERT молча падает, строка теряется без error в response.

7. **Phase 1 Directories→Nomenclature** не закрыта полностью. Местами всё ещё используется legacy `parts.list` без зеркала в `erp_nomenclature` — stub-выбор может попасть на orphan-запись.

### Решения пользователя (зафиксированы)

- **Объём**: полный аудит цепочки, серия релизов 1.21.0–1.22.0 (3–5 сессий).
- **Автогенерация stub-строк**: УБРАТЬ. Заменить на warning-баннер «Не хватает строки типа X» + кнопка «Добавить». Карточка НЕ мутирует `data` сама.
- **Виджет тип+компонент**: один объединённый `GroupedSearchSelect`, варианты сгруппированы по типу. Тип всегда соответствует выбору. Рассинхрон невозможен.

### Стратегия

Снимать слой за слоем, по одному релизу на слой. Каждый релиз оставляет цепочку BOM в работоспособном состоянии. **Принципы**:
- **Не-мутирующий UI**: после v1.21.0 карточка никогда сама не модифицирует `data` — только показывает диагностику.
- **Неизменность priority**: после v1.21.0 priority выкинуто из snapshot (разрывает обратную связь); после v1.21.3 backend перестаёт переписывать priority (он становится валидным полем snapshot).
- **Тип ≡ категория**: после v1.21.1 рассинхрон componentType ↔ nomenclature невозможен по построению UI; после v1.21.2 backend это закрепляет валидацией.

---

## v1.21.0 — Фундамент: не-мутирующий UI + snapshot без priority

**Цель.** Карточка перестаёт сама добавлять stub-строки. Snapshot не зависит от priority. Это снимает источник «исчезновений» и фантомного dirty.

**Изменения** (только клиент, backend без правок):

1. **Удалить useEffect автогенерации** ([EngineAssemblyBomDetailsPage.tsx:768-856](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L768)) полностью. Заменить на чистый `useMemo missingComponentTypes: Array<{ scope, missingTypeIds }>` без `setData`.

2. **Warning-баннер** перед таблицей `variantBlocks`: «Не хватает типов: Картер, Головка. [Добавить пустую строку Картер] [Добавить пустую строку Головка]». Кнопка вызывает `setData` append с `componentNomenclatureId: ''`, `componentType: typeId`, `qtyPerUnit: 0`. **Без stub-UUID** — пустая строка подсвечивается существующим `validatePreparedLines` как «не выбран компонент».

3. **Исключить `priority` из `buildBomSnapshot`** ([:226-251](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L226)) — удалить поле из JSON.stringify. Так же убрать `version` из header-части (server bump'ает, dirty-irrelevant).

4. **Дисейблить кнопку «Добавить вариант сборки из схемы»** ([:2158](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L2158)) если в текущем варианте есть строки с пустым `componentNomenclatureId`. Подсказка: «Заполните пустые строки прежде чем добавлять новый вариант».

5. **Пустой BOM** — заменить автоскелет на banner «BOM пустая, добавьте строки» + кнопки [Добавить строку] [Добавить вариант сборки из схемы].

**Закрывает причины:** #1 полностью; #2 на стороне клиента (priority выкинут); #4 частично (на клиенте больше нет вызовов pickStub в useEffect).

**Риски:**
- Пользователи привыкли что карточка сама добавляет строки → объяснить в `RELEASE_WELCOME_HISTORY`.
- На проде в DB могут остаться старые BOM со stub-строками от прежних версий. Добавить read-only скрипт `scripts/audit-bom-stub-rows.mjs` (отчёт, не удаление) — записи где `qtyPerUnit=0 AND notes LIKE 'Черновик строки%'`.

**Тестирование:**
- Сценарий 1 verification plan (открыл-закрыл без изменений → не просит сохранять).
- Сценарий 2 (изменил-сохранил-открыл → данные на месте).
- Unit-тест: `EngineAssemblyBomDetailsPage.snapshot.test.ts` — снапшот стабилен при изменении только priority.
- Unit-тест: чистая функция `computeMissingComponentTypes(lines, requiredTypes)` для разных конфигов (base / kit / пустой).

**Rollback:** клиентский релиз без DB-изменений. Откат = переустановить v1.20.5.exe. Данные не повредятся.

---

## v1.21.1 — Объединённый виджет «тип+компонент»

**Цель.** Заменить два контрола в строке (select типа + SearchSelect номенклатуры) на один `GroupedSearchSelect` с группировкой по типу. Рассинхрон componentType ↔ nomenclature становится невозможен.

**Изменения:**

1. **Новый компонент** `electron-app/src/renderer/src/ui/components/GroupedSearchSelect.tsx` — расширение существующего `SearchSelect` с поддержкой `groups: Array<{ groupLabel, items: Array<{ id, label, hintText, componentTypeId }> }>`. Callback `onChange(itemId, componentTypeId)`.

2. **Backend** `listNomenclature` ([warehouseService.ts](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseService.ts)) — добавить поле `componentTypeId: string | null` в выдачу. Источник: `attributes.component_type_id` через EAV (введёт v1.22.0 как колонка) либо derive из `category` (engine → 'engine', иначе null).

3. **В таблице строк BOM** ([:1962-1992](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L1962)): удалить колонку-select «Тип», заменить SearchSelect компонента на `GroupedSearchSelect`. Callback: `(nomenclatureId, typeId) => patchLine(idx, { componentNomenclatureId: nomenclatureId, componentType: typeId })` — атомарный апдейт обоих полей.

4. **Колонка «Тип»** остаётся read-only label рядом с компонентом — для печати и понимания.

5. **Удалить эвристики** `TYPE_SEARCH_TOKENS` ([:82](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L82)) и `componentOptionsByType` ([:483-500](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L483)) — больше не нужно угадывать «строка с „гильз" — это sleeve» по названию.

6. **В карточке номенклатуры** ([NomenclatureDetailsPage.tsx](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\NomenclatureDetailsPage.tsx)) добавить поле «Тип компонента BOM» — SearchSelect из глобальной схемы (`relationNodes` без root). Хранить через EAV `attributes.component_type_id` пока (отдельная колонка — в v1.22.0).

**Закрывает причины:** #3 полностью.

**Риски:**
- Старая номенклатура без `componentTypeId` попадёт в группу «Прочее». Добавить one-time скрипт `scripts/backfill-nomenclature-component-type.mjs` — для каждой номенклатуры с известным `name` (содержит «гильз»/«поршень»/«картер»/…) предложить через CLI заполнить.
- UX-разрыв: пользователь привык к отдельной колонке типа. Tooltip с пояснением «Тип определяется выбранной номенклатурой».

**Тестирование:**
- Открыть строку «Картер» — увидеть в одном select-е «Картер ▸ модель А; Гильза ▸ …». Выбрать модель из группы Картер — после save+reload тип строки «Картер».
- Unit-тест `buildGroupedBomOptions` (новый shared-util): группировка + сортировка по `sortOrder` схемы.
- Компонентный тест `GroupedSearchSelect`: callback с двумя значениями.

**Rollback:** feature-flag в `client_settings_ui_display_prefs.bom_use_grouped_select`, default true. Старый код оставить fallback-render на 1 релиз.

---

## v1.21.2 — Backend валидация componentType ↔ nomenclature + удаление fallback в pickStub

**Цель.** Backend становится единственным арбитром правила «componentType строки должен совпадать с componentTypeId её номенклатуры». Убран последний fallback на «первую попавшуюся».

**Изменения:**

1. **Валидация при upsert** ([warehouseBomService.ts:480-502](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L480)). После `.filter((line) => line.componentNomenclatureId)`: загрузить `nomenclatureById` для всех `componentNomenclatureId`, для каждой строки проверить `componentType === nomenclatureById[id].componentTypeId`. При несовпадении — добавить в `warnings: string[]` (новое поле response). **НЕ блокировать save** в первой итерации — warning видит пользователь.

2. **Удалить fallback на «любую активную»** ([warehouseBomService.ts:144-150](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L144) `anyActive` в `pickLineDraftStubNomenclatureId`). Если нет engine-номенклатуры → `null`. В вызывающем коде ([:428-435](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L428)) ошибка: «Для марки X нет ни одной номенклатуры типа engine. Создайте engine-номенклатуру».

3. **Клиент**: убрать строки 764-765 в `pickBomDraftStubNomenclatureFromMeta` ([shared/warehouse.ts:749](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts#L749)) — тот же fallback на `first`.

4. **Удалить авто-скелет на backend** ([warehouseBomService.ts:467-477](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L467)) — секция `if (sourceLines.length === 0)`. Пустой BOM — валидное состояние. Backend больше не fabricует строки.

5. **`buildEngineBomSkeletonBlockLines`** ([shared/warehouse.ts:913](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts#L913)) — разрешить `stubComponentNomenclatureId: ''` (пустая строка). Скелет генерируется с пустыми компонентами.

6. **В response `loadBomDetailsById`** ([warehouseBomService.ts:294](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L294)) добавить header-поле `componentTypeByNomenclatureId: Record<string, string | null>` — для UI-диагностики рассинхрона.

**Закрывает причины:** #4 полностью; #7 частично; #3 валидация.

**Риски:**
- На проде есть BOM с рассинхрон-componentType от прежних версий → лавина warning-баннеров. Pre-release SQL-аудит + опциональный скрипт `scripts/sync-bom-line-component-type.mjs` (пересинхронизирует componentType из nomenclature.componentTypeId).
- Жёсткий отказ создавать BOM без engine-номенклатуры — error message с инструкцией.
- Пустой BOM валиден → forecast должен handle'ить (уже handles, см. [warehouseForecastService.ts:300-330](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseForecastService.ts#L300)), подтвердить юнит-тестом в v1.22.0.

**Тестирование:**
- Создать BOM для марки без engine-номенклатуры → чёткая ошибка с инструкцией.
- Через curl сохранить BOM с рассинхроном componentType → response с `warnings: [...]`, BOM сохранён.
- Unit: `warehouseBom.componentTypeValidation.test.ts`, `warehouseBom.pickStub.test.ts` (нет fallback).

**Rollback:** backend-only + 1 клиентский баннер. Откат backend → клиент молча игнорирует отсутствующий `warnings`.

---

## v1.21.3 — Убрать BOM_SKELETON_KNOWN_COMPONENT_TYPES + dedup INSERT + priority читается как есть

**Цель.** Финальная зачистка: shared-skeleton использует всю активную схему (без whitelist), backend pre-check на дубли строк (защита от молчаливой потери), `priority` хранится как-получено от клиента.

**Изменения:**

1. **Удалить константу** `BOM_SKELETON_KNOWN_COMPONENT_TYPES` ([shared/warehouse.ts:885](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts#L885)). В `buildEngineBomSkeletonBlockLines` ([:920-946](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts#L920)) заменить фильтр на `n.typeId && n.typeId !== rootId && n.isActive !== false`. Skeleton = все active типы схемы.

2. **Удалить `FALLBACK_COMPONENT_TYPES`** ([EngineAssemblyBomDetailsPage.tsx:71](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L71)) и `DEFAULT_COMPONENT_TYPE_LABELS` ([:73-81](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L73)). При ошибке загрузки схемы — показать status, без хардкод-fallback.

3. **Backend pre-check дублей** ([warehouseBomService.ts:611-630](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L611)). До INSERT сгруппировать `normalizedWithMeta` по ключу `(variantGroup, componentNomenclatureId, componentType)` — если дубль, вернуть `{ ok: false, error: 'BOM не сохранён: дубль строки (variant=X, type=Y, nomenclature=Z). Удалите дубль.' }`. Превращает молчаливую потерю в чёткую ошибку 400.

4. **Backend НЕ перезаписывает priority** ([warehouseBomService.ts:493](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts#L493)). Заменить `priority: schemaPriorityFor(...)` на `priority: Math.max(0, Math.trunc(Number(line.priority ?? 100)))`. **Удалить функцию** `reorderAllBomLinesBySchema` (через grep найти всех вызывающих, заменить на новую UI-кнопку «Пересортировать по схеме»).

5. **Восстановить `priority` в `buildBomSnapshot`** ([EngineAssemblyBomDetailsPage.tsx:226](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L226)) — теперь безопасно, backend не переписывает.

6. **UI-кнопка** «Пересортировать по схеме» в bottom bar карточки BOM — локально устанавливает priority = schema.sortOrder для всех строк. Явное действие пользователя.

**Закрывает причины:** #5 полностью; #6 полностью; #2 полностью.

**Риски:**
- На проде могут быть BOM с дублями строк, созданные до migration 0043. Pre-release SQL-аудит + скрипт `scripts/cleanup-bom-duplicate-lines.mjs` (merge через CLI prompt).
- Удаление `reorderAllBomLinesBySchema` — найти всех вызывающих через grep. Если вызывается в route hook после изменения схемы → заменить на batch UI-action.

**Тестирование:**
- Добавить в схему тип `crankshaft`, кнопка «Добавить вариант сборки из схемы» → скелет содержит строку crankshaft (раньше бы не было).
- Создать BOM с двумя одинаковыми `(variantGroup, type, nomenclature)` → error.
- Изменить priority строки 100 → 5, save → reload → priority=5.
- Unit: `warehouseBom.duplicateLines.test.ts`, `buildEngineBomSkeletonBlockLines.test.ts` (с кастомными типами), `warehouseBom.priorityPreserved.test.ts`.

**Rollback:** backend откат к v1.21.2. Клиент работает (просто получит ошибки на дубли от старого backend).

---

## v1.22.0 — Forecast edge cases + part↔nomenclature mirror + DDL component_type_id

**Цель.** Закрепительный релиз: тесты прогноза на edge-cases, аудит и фикс orphan-записей mirror'а Phase 1, выделенная колонка `component_type_id` в `erp_nomenclature`.

**Изменения:**

1. **Forecast edge cases** ([warehouseForecastService.ts:226-333](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseForecastService.ts#L226) + [shared/assemblyForecast.ts](D:\GitHubReps\MatricaRMZ\shared\src\domain\assemblyForecast.ts)). Покрыть тестами и адресно фиксить если найден баг:
   - Пустой BOM → warning «BOM марки X не содержит строк», не падает.
   - Строка BOM ссылается на удалённую номенклатуру (`deletedAt IS NOT NULL`) → exclude + warning «N строк пропущено».
   - Variant kit без полного набора (есть sleeve+piston, нет ring) → warning «Вариант __kit_xxx неполный».
   - Несколько kit-вариантов для марки → каждый отображается как отдельный комплект с suffix «(вариант N)».
   - **Warning при коллизии**: для марки несколько `active+isDefault` BOM → используется свежий по `updatedAt`, warning «Несколько default BOM для марки X, архивируйте ненужные».

2. **Audit скрипт** `scripts/audit-parts-mirror.mjs` — read-only SQL-запросы:
   - Orphan в `entities` (type=part), нет `directory_parts`
   - Orphan в `directory_parts`, нет `entities`
   - `erp_nomenclature` с `directory_kind='part'`, нет `directory_parts`
   - Выводит counts. Сопровождающий скрипт `scripts/fix-parts-mirror.mjs --apply` восстанавливает зеркало (как [partsService.ts:2312-2327](D:\GitHubReps\MatricaRMZ\backend-api\src\services\partsService.ts#L2312)).

3. **Финал Phase 1 миграции** — найти оставшиеся места legacy `parts.list` без зеркала. Проверить [PartsPage.tsx](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\PartsPage.tsx) (фильтр по марке через `engine_brand_ids` EAV) и [PartDetailsPage.tsx](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\PartDetailsPage.tsx) (синхронизация `attributes.name` ↔ `erp_nomenclature.name`). Документировать оставшиеся не-зеркальные fields в `docs/MIGRATION_PARTS_TO_NOMENCLATURE.md`.

4. **DDL migration** `0054_nomenclature_component_type_id.sql`:
   ```sql
   ALTER TABLE erp_nomenclature ADD COLUMN component_type_id text;
   CREATE INDEX erp_nomenclature_component_type_idx ON erp_nomenclature (component_type_id) WHERE deleted_at IS NULL;
   ```
   Перевести `componentTypeId` из EAV (v1.21.1) на выделенную колонку. Backfill: для существующих → derive из `category` (engine → 'engine'), остальные null.

5. **UI карточки номенклатуры** ([NomenclatureDetailsPage.tsx](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\NomenclatureDetailsPage.tsx)) — поле «Тип компонента BOM» сохраняется в колонку `component_type_id` напрямую (а не через EAV).

**Закрывает причины:** #7 полностью + edge-cases прогноза.

**Риски:**
- DDL ADD COLUMN текстовое поле без NOT NULL — атомарно в PG, мгновенно.
- Backfill `category → componentTypeId` может потерять тонкости. Делать только для однозначных случаев, остальные — null, пользователь заполнит вручную (warning в UI «Незаполненный componentTypeId»).

**Тестирование:**
- Сценарии 5, 6, 7 verification plan.
- Unit: `assemblyForecast.emptyBom.test.ts`, `warehouseForecast.multipleDefaults.test.ts`.
- `node scripts/audit-parts-mirror.mjs` на проде → 0 orphan'ов во всех категориях.

**Rollback:** колонку `component_type_id` оставить (drop ломает клиент), откатить только client+backend. Скрипты audit — read-only по умолчанию.

---

## Сводная таблица релизов

| Релиз | Закрывает | Backend | DB | Client | Effort |
|---|---|---|---|---|---|
| v1.21.0 | #1, #2(part), #4(part) | нет | нет | EngineAssemblyBomDetailsPage.tsx крупные правки | средне |
| v1.21.1 | #3 | расширить nomenclatureList | нет | GroupedSearchSelect + замена в карточке | средне |
| v1.21.2 | #3(валидация), #4, #7(part) | warehouseBomService + shared | нет | warning баннер | средне |
| v1.21.3 | #5, #6, #2 | warehouseBomService + shared | нет | удаление FALLBACK хардкодов + UI-кнопка | средне |
| v1.22.0 | #7 + forecast edge-cases | warehouseForecastService | колонка `component_type_id` | поле в карточке номенклатуры | больше |

---

## Критические файлы для имплементации

- [EngineAssemblyBomDetailsPage.tsx](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx) — главный UI (2175 строк)
- [warehouseBomService.ts](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomService.ts) — backend BOM
- [warehouseForecastService.ts](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseForecastService.ts) — backend forecast
- [shared/warehouse.ts](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts) — skeleton, stub-picker, schema sanitization
- [shared/assemblyForecast.ts](D:\GitHubReps\MatricaRMZ\shared\src\domain\assemblyForecast.ts) — прогноз
- [routes/warehouse.ts](D:\GitHubReps\MatricaRMZ\backend-api\src\routes\warehouse.ts) — REST endpoints
- [NomenclatureDetailsPage.tsx](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\NomenclatureDetailsPage.tsx) — карточка номенклатуры
- [partsService.ts](D:\GitHubReps\MatricaRMZ\backend-api\src\services\partsService.ts) — mirror логика
- `backend-api/drizzle/*.sql` — новая migration 0054

## Существующие утилиты для переиспользования

- `sanitizeWarehouseBomRelationSchema`, `normalizeBomRelationKey` ([shared/warehouse.ts](D:\GitHubReps\MatricaRMZ\shared\src\domain\warehouse.ts))
- `useConfirm` хук
- `CardActionBar`, `SearchSelect`, `SearchSelectWithCreate` (база для `GroupedSearchSelect`)
- `serializeWarehouseBomLineMeta` / `parseWarehouseBomLineMeta` ([warehouseBomLineMeta.ts](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseBomLineMeta.ts))
- `validatePreparedLines` ([EngineAssemblyBomDetailsPage.tsx:268](D:\GitHubReps\MatricaRMZ\electron-app\src\renderer\src\ui\pages\EngineAssemblyBomDetailsPage.tsx#L268)) — переиспользовать для подсветки пустых строк
- `loadActiveDefaultBomKits` ([warehouseForecastService.ts:226](D:\GitHubReps\MatricaRMZ\backend-api\src\services\warehouseForecastService.ts#L226)) — точка для warning'ов о коллизиях default BOM

---

## End-to-end verification plan (после v1.22.0)

Ручной regression script, со скриншотами, документируется в `docs/DEVELOPMENT_LOG.md`:

### Сценарий 1 — «Открыл-закрыл без изменений»
Открыть BOM «В-46», не нажимая ничего нажать «Закрыть». **Ожидание:** карточка закрывается мгновенно, БЕЗ диалога «Сохранить изменения?». `isBomDirty=false` в DevTools.

### Сценарий 2 — «Изменил-сохранил-открыл»
Открыть BOM, в строке «Картер» выбрать модель, нажать «Сохранить», закрыть, открыть снова. **Ожидание:** в строке Картер — выбранная модель. Тип строки = «Картер». `componentType` совпадает с `componentTypeId` номенклатуры.

### Сценарий 3 — «Изменил схему — открыл существующий BOM»
В глобальной схеме добавить тип `crankshaft` (sortOrder=70, active=true). Открыть существующий BOM. **Ожидание:** warning-баннер «Не хватает строки типа Коленвал. [Добавить пустую]». Карточка НЕ модифицирует `data`. `isBomDirty=false`. После нажатия «Добавить пустую» → строка появилась, валидация подсвечивает «не выбран компонент», `isBomDirty=true`.

### Сценарий 4 — «Создать новую BOM с нуля»
Создать BOM для марки X, сохранить пустую. **Ожидание:** BOM создана без ошибки. Открыть → banner «BOM пустая». «Добавить вариант сборки из схемы» → N строк (по active типам), все с пустыми компонентами, все с правильным типом.

### Сценарий 5 — «Прогноз на чистом BOM»
Заполнить все строки BOM, qtyPerUnit=1, запустить прогноз на 7 дней. **Ожидание:** прогноз корректен, дефицит/наличие отображаются, нет warnings.

### Сценарий 6 — «Forecast при удалённой номенклатуре»
Soft-delete одну номенклатуру, на которую ссылается строка BOM. Запустить прогноз. **Ожидание:** warning «1 строка пропущена из-за удалённой номенклатуры», прогноз работает для остальных.

### Сценарий 7 — «Mirror audit»
На проде запустить `node scripts/audit-parts-mirror.mjs`. **Ожидание:** 0 orphan'ов во всех 3 категориях.

---

## Список тестов которые нужно добавить

### shared
- `__tests__/buildEngineBomSkeletonBlockLines.test.ts` — корректный скелет по любой схеме (включая кастомные типы)
- `__tests__/groupedBomOptions.test.ts` — группировка для GroupedSearchSelect
- `__tests__/warehouse.pickStub.test.ts` — НЕ возвращает «первую попавшуюся»
- `__tests__/assemblyForecast.emptyBom.test.ts` — edge cases прогноза

### backend-api
- `tests/warehouseBom.componentTypeValidation.test.ts` — все ветки правила componentType ≡ componentTypeId
- `tests/warehouseBom.pickStub.test.ts` — никакого fallback на «любую активную»
- `tests/warehouseBom.duplicateLines.test.ts` — pre-check dedup
- `tests/warehouseBom.priorityPreserved.test.ts` — priority не переписывается
- `tests/warehouseBom.emptyBomSave.test.ts` — пустая BOM валидна
- `tests/warehouseForecast.multipleDefaults.test.ts` — warning коллизии default BOM
- `tests/warehouseForecast.emptyBomKit.test.ts` — forecast не падает на пустых kit'ах

### electron-app
- `pages/__tests__/EngineAssemblyBomDetailsPage.snapshot.test.ts` — snapshot стабилен (1.21.0) → снова включает priority (1.21.3)
- `pages/__tests__/EngineAssemblyBomDetailsPage.missingTypes.test.ts` — pure function расчёта missing types
- `components/__tests__/GroupedSearchSelect.test.tsx` — callback с двумя значениями
- `pages/__tests__/EngineAssemblyBomDetailsPage.noMutation.test.ts` — после mount + schema change, карточка не мутирует `data` (spy на setData)

---

## Релизный процесс (соблюдать)

См. CLAUDE.md «Release process». Для каждого релиза:
1. `node scripts/bump-version.mjs --set X.Y.Z`
2. Запись в `shared/src/domain/releaseWelcome.ts` (prepend в `RELEASE_WELCOME_HISTORY`)
3. Запись в `docs/DEVELOPMENT_LOG.md`
4. Обновить `docs/PENDING_FOLLOWUPS.md` (вычеркнуть закрытые пункты)
5. Commit + tag → push → SSH прод → `git pull --ff-only && pnpm install && build shared/backend-api/web-admin && restart primary→secondary`
6. После GitHub Action: `gh release download vX.Y.Z --pattern "*.exe" -D /opt/matricarmz/updates --skip-existing`
7. `corepack pnpm release:ledger-publish X.Y.Z`
