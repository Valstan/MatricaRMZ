# Phase 3.5 — депрекация оси «шаблон детали» (path B)

> **🏁 ЗАВЕРШЕНО 2026-06-08.** PR-1 ([#275](https://github.com/Valstan/MatricaRMZ/pull/275)) → релиз **v1.46.0** на проде (UI-вкладка + выпадашка убраны, IPC снят, весь `/parts/*` → 410, `partsService.ts` удалён; `/verify` CDP PASS). PR-2 ([#277](https://github.com/Valstan/MatricaRMZ/pull/277)) → backend-only деплой: дроп `PartSpec.templateId` + колонки `directory_parts.template_id` (миграция **0061**, expand-contract restart→drop), + EAV soft-delete под G29 (153 `part_template` + 162 + 132 attr-values; бэкап `~/backup-parttemplate-eav-softdelete-pre-2026-06-08-1259.dump`). **parts-EAV функционально и физически в ноль** (живых `part_template` строк 0). `nomenclature`-шаблоны (governance) не затронуты. Прод: v1.46.0, колонка=0, миграции=61.

> Утверждён 2026-06-08. Заменяет отложенную «Phase 3.5: миграция part-шаблонов → directory». Разведка показала, что
> `part_template` — не шаблон, а плоская метка-категория (только атрибуты `name`/`description`, нулевое поведение:
> выбор шаблона ничего не подставляет/не валидирует). Владелец признал ось рудиментом → **выпиливаем**, а не мигрируем.

## Context

«Шаблон детали» (`/parts/templates/*`, EAV `entities type=part_template`) — последний живой кусок parts-EAV после
Phase 3.7. Это справочник из 153 строк `{name, description}`; деталь помечается одним `templateId`
(`directory_parts.template_id`, 125/125 заполнены). Функционально метка не делает ничего —
[NomenclatureDetailsPage.tsx:869](../../electron-app/src/renderer/src/ui/pages/NomenclatureDetailsPage.tsx)
просто селект, значение кладётся в part-spec и нигде не читается для логики. У детали уже есть своя группировка
(nomenclature-группа + тип). Ось избыточна.

**Цель:** убрать ось целиком — UI-вкладку «Справочник деталей» + выпадашку в карточке детали, 410 на `/parts/templates/*`,
снести dead EAV-функции (вкл. последний живой read `entities type=part`), обнулить parts-EAV.

**Прод (снимок 2026-06-08):** `part_template` EAV = **153**; `directory_parts.template_id` ≠ null = **125/125**;
`erp_part_templates` (strict-таблица) = **0** строк (пустой дубль, не используется).

## Карта call-site'ов (проверено 2026-06-08)

**Клиент (renderer):**
- [`App.tsx`](../../electron-app/src/renderer/src/ui/App.tsx) — `PartTemplatesPage`/`PartTemplateDetailsPage` lazy-import (110-111), tab-id `part_templates`/`part_template` в union/labels/parents (388-449, 1443, 1472, 2020-2059), `selectedPartTemplateId` (528, 1166, 1217, 2165, 2214), `openPartTemplate` (1884-1886), breadcrumb (2087), render-блоки (3575, 3678, 3967), tab-gate (1700, 2524), production-меню (1420).
- [`Tabs.tsx`](../../electron-app/src/renderer/src/ui/layout/Tabs.tsx) — union (42-71), parent map (102), order (140), `production`-группа (190), label (512).
- [`NomenclatureDetailsPage.tsx`](../../electron-app/src/renderer/src/ui/pages/NomenclatureDetailsPage.tsx) — `specTemplateId`/`partTemplateOptions` state (116-117), загрузка опций (`parts.templates.list`), запись `templateId` в spec (511), выпадашка (869-871).
- Удаляются: `PartTemplatesPage.tsx`, `PartTemplateDetailsPage.tsx`.

**Клиент (main/preload/IPC):**
- [`preload/index.ts:408-413`](../../electron-app/src/preload/index.ts) — `parts.templates.{list,get,create,updateAttribute,delete}`.
- [`main/ipc/register/parts.ts:47-85`](../../electron-app/src/main/ipc/register/parts.ts) — хендлеры `parts:templates:*` + `parts:createFromTemplate`.
- [`main/services/partsService.ts:174-330`](../../electron-app/src/main/services/partsService.ts) — HTTP-обёртки шаблонов + `templateId`/`templateName` поля в `parts.list`.
- `shared/src/ipc/types.ts` — типы `parts.templates.*` в `MatricaApi`.

**Backend:**
- [`routes/parts.ts:37-145`](../../backend-api/src/routes/parts.ts) — `/templates` GET/POST, `/templates/:id` GET/DELETE, `/templates/:id/attributes/:code` PUT → **410** (`/templates/:id/create-part` уже 410). После этого ВЕСЬ `/parts/*` = 410.
- [`partsService.ts`](../../backend-api/src/services/partsService.ts) — снести `listPartTemplates`/`getPartTemplate`/`createPartTemplate`/`updatePartTemplateAttribute`/`deletePartTemplate` + приватные (`ensurePartTemplateEntityType`/`ensurePartTemplateAttributeDefs`/`getPartTemplateEntityTypeId`/`findPartTemplateDuplicateId`/`createPartTemplateEntity`/**`ensureExistingPartTemplateAssignments`**) + консты. Это последний живой read `entities type=part`.
- [`warehouseService.ts:1997`](../../backend-api/src/services/warehouseService.ts) — снести `resolvePartTemplateNames` + `templateName`/`templateId`-фильтр из `listWarehouseNomenclaturePartSpecs`; перестать читать/писать `template_id` в part-spec (`rowToPartSpec`, `upsertWarehouseNomenclaturePartSpec` — **игнорировать** входящий `spec.templateId` для совместимости со старыми клиентами).
- [`ai/claudeTools.ts:324`](../../backend-api/src/services/ai/claudeTools.ts) — убрать `erp_part_templates` из allowlist.
- Тесты: `parts.gone.test.ts` (templates теперь 410, убрать страж «GET /templates alive»), partSpec roundtrip (без `templateId`).

## Стадии

Правило auto-update: бэкенд терпит старых клиентов. Старый клиент после релиза зовёт `parts.templates.list` → 410 →
вкладка «Справочник деталей»/выпадашка пустые — **приемлемая деградация** (тот же класс, что Stage H 410), фича всё равно
удаляется. Поэтому клиент+бэкенд можно слить в один релиз.

### PR-1 — выпиливание оси (client + backend, один релиз)
1. **Клиент UI:** убрать вкладки `part_templates`/`part_template` из `App.tsx`+`Tabs.tsx` (меню, union, labels, render, gate, state, opener, breadcrumb); удалить `PartTemplatesPage.tsx`/`PartTemplateDetailsPage.tsx`; в `NomenclatureDetailsPage` убрать выпадашку шаблона + `specTemplateId`/`partTemplateOptions` + загрузку опций; перестать слать `templateId` в spec-upsert.
2. **Клиент IPC:** убрать `parts.templates.*` + `createFromTemplate` из preload/main-register/main-partsService/MatricaApi.
3. **Backend:** 410 на все `/templates*`; снос dead EAV-функций (вкл. `ensureExistingPartTemplateAssignments`); снос `resolvePartTemplateNames`+`templateName`/`templateId`-фильтра; игнор `spec.templateId` в upsert; убрать `erp_part_templates` из AI-allowlist.
4. **Совместимость:** `PartSpec.templateId` в shared и колонку `directory_parts.template_id` **оставляем физически** (deprecated, не читается/не пишется) → PR без миграции, полностью обратимый.
5. **Тесты:** `parts.gone` (+5 routes→410), partSpec roundtrip; backend typecheck+test; electron typecheck+eslint.
6. **Verify:** `/verify` CDP — карточка детали открывается/сохраняется без выпадашки шаблона; в меню «Производство» нет «Справочник деталей»; список деталей (Admin/EngineBrand) рендерит без `templateName`.
7. Релиз → прод (backend-only-данных не трогает).

### PR-2 — физическая зачистка (опц., low-pri; «parts-EAV в ноль» физически)
- shared: убрать `templateId`/`templateName` из `PartSpec`.
- warehouseService: убрать `template_id` из read/write part-spec.
- Миграция: `DROP COLUMN directory_parts.template_id`.
- **Прод (G29, под явным подтверждением):** `pg_dump` бэкап → soft-delete 153 `entities type=part_template` + их `attribute_values` + `templateId`-attribute_values на `entities type=part`. После этого parts-EAV физически пуст. Row-counts в теле PR.

Функционально parts-EAV «в ноль» (нет живых read/write) уже после **PR-1**; PR-2 — косметика стора и удаление мёртвых строк/колонки.

## Риски / контроль
1. **Старые клиенты** после PR-1 — `parts.templates.*`→410, вкладка пустая. Деградация деприкируемой поверхности, не регресс данных (как Stage H). Эмпирический гейт версий перед `/reliz` (реестр `client_settings`) — по образцу Stage H.
2. **`directory_parts.template_id` остаётся колонкой** после PR-1 (125 stale значений) — мёртвые данные в directory, не EAV; чистятся в PR-2. Безопасно.
3. **`erp_part_templates` (0 строк)** — дропать таблицу не обязательно (пустая, вне scope); опционально в PR-2.
4. **`parts.list` (electron main) `templateId`/`templateName`** — поля HTTP-обёртки; убрать вместе с IPC, проверить что `mapPartRowsToSearchOptions`/`listAllPartSpecs` ([partsPagination.ts](../../electron-app/src/renderer/src/ui/utils/partsPagination.ts)) не падают без `templateName` (поле кормило только hint выпадашки — удаляется).

## Верификация
- Backend: `corepack pnpm -F @matricarmz/backend-api typecheck && test` (parts.gone, partSpec roundtrip).
- Клиент: `corepack pnpm -F electron-app typecheck` + eslint затронутых.
- E2E: `/verify` (verifier-electron CDP) — карточка детали без шаблона, меню без вкладки, списки деталей.
- Прод после релиза: `/health` + `/updates/status` = новая версия.

## Не входит
- Снос пустой `erp_part_templates` таблицы — опционально в PR-2.
- Дроп `entities type=part` строк целиком (заморожены Phase 3.7) — отдельная низкоприоритетная нитка.
