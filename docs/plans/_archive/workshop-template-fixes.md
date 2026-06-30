# Workshop-template — фикс + расширения (v1.27.0)

Версия плана: 2026-05-26
Инициатор: пользователь, после первого использования v1.26.0
Preempted by: [нет — новая нитка]

## Контекст

После раскатки v1.26.0 («Ремонт по шаблону цеха») пользователь попробовал создать наряд и:

1. **Баг закрытия:** `Ошибка закрытия: Не удалось провести документ: Недостаточно остатка для <UUID> на складе repair_fund`. Под капотом Workshop-наряд использовал `docType = 'repair_recovery'` — он списывает с `repair_fund` (ремфонд) и приходует на склад цеха. Это правильно для классического Repair (детали приходят в repair_fund при разборке двигателя через `engine_dismantling`), но не для Workshop (там нет привязки к двигателю).
2. **UI:** при `[Закрыть и провести]` показал текст «детали спишутся со склада цеха в сборку» — это шаблон Assembly, потому что в `WorkOrderDetailsPage.tsx` ветка для WorkshopTemplate отсутствовала в switch и провалилась в дефолтный `else`.
3. **Запросы:**
   - Множественные шаблоны на цех (с именами).
   - Поле «Вид работы» у каждой детали шаблона.
   - Расширить колонки наименования в таблицах шаблонов и нарядов.

## Решённые развилки (зафиксированы 2026-05-26 пользователем)

- ✅ **Repair-наряд тоже перестаёт списывать с repair_fund.** Бизнес-причина: разборка двигателя в `repair_fund` пока не работает корректно — списки деталей по маркам не актуальные, могут не совпадать с BOM сборки → накапливаются «призраки», которые не уходят в сборку. Пока **«Разборка двигателя» замораживается**, и все ремонтные наряды (Repair + WorkshopTemplate) делают **только приход** на склад цеха, как новые детали (`production_release`).
- ✅ **`engine_dismantling` UI замораживаем.** Кнопка «Провести разборку» в `EngineDetailsPage` скрывается. Backend-логика и существующие документы не трогаются (на случай починки в будущем).
- ✅ **Накопленные остатки на `repair_fund`** не трогаем. Лежат как есть, пока бизнес не решит что с ними делать.
- ✅ **Множественные шаблоны на цех:** N:1 (N шаблонов на 1 цех). Каждый со своим `name`. CRUD через UI.
- ✅ **Выбор шаблона при применении:** диалог выбора из списка при клике `[Применить шаблон]` в наряде (не dropdown в шапке).
- ✅ **«Вид работы»:** dropdown из справочника `services` (Услуги). Единый справочник, тот же что используется в обычных нарядах. Фильтрация по марке двигателя не применяется (Workshop без привязки к двигателю — показываем все услуги).
- ✅ **Один релиз v1.27.0** со всеми изменениями (фикс + фичи).

## Архитектура изменений

### PR 1 — backend closing: Repair + Workshop → production_release

**[backend-api/src/services/workOrderClosingService.ts](../../backend-api/src/services/workOrderClosingService.ts):**

- В ветке `WorkOrderKind.Repair || WorkOrderKind.WorkshopTemplate`:
  - `docType: 'production_release'` (было `'repair_recovery'`).
  - `docNoPrefix: WorkshopTemplate ? 'WSR' : 'REP'` — оставляем.
  - `payloadJson` для line: `{ nomenclatureId, targetWarehouseId, warehouseId: targetWarehouseId }` — как у Manufacturing (см. ветка `Manufacturing` line 284-295). Поле `engineId` убрать (для Repair оно сейчас задаётся в `engineIdForMovements` — но при `production_release` под parts-movement-marker оно не используется, проверить что не ломает legacy ветку).
- Убрать пометку `parts_movement_v1` для `production_release` (оно идёт через generic-incoming, без специальной ветки). Точнее — оставить как есть у Manufacturing.

**[electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx](../../electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx) ~ строки 1316-1346:**

- `tooltip` и `confirmDetail` — для `WorkOrderKind.Repair` и `WorkOrderKind.WorkshopTemplate` показать одинаковый текст про `production_release`:
  - tooltip: `'Создаст и проведёт документ production_release — отремонтированные/выпущенные детали поступят на склад цеха'`.
  - confirmDetail: `'Будет создан и проведён документ production_release (детали поступают на склад цеха как новые). Действие необратимо без сторнирования.'`.
- Добавить отдельную ветку `WorkshopTemplate` рядом с `Repair`.

**Тесты:** `backend-api/tests/integration/workOrderClosing.test.ts` (если есть) или unit на pure-helper — проверить что Workshop+Repair создают document type `production_release`, документ постится без обращения к `repair_fund`.

### PR 2 — заморозить «Разборка двигателя»

**[electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx](../../electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx) строка ~901:**

- Скрыть кнопку «Провести разборку» (либо `if (false)`, либо вынести за feature-flag `FEATURE_ENGINE_DISMANTLE = false`).
- В коде оставить комментарий «Заморожено по решению 2026-05-26 — см. docs/plans/workshop-template-fixes.md».

**[electron-app/src/renderer/src/ui/components/EngineDismantlePreviewDialog.tsx](../../electron-app/src/renderer/src/ui/components/EngineDismantlePreviewDialog.tsx):**

- Файл оставить в репо. Не вызывается, когда кнопка скрыта.

Backend `engine_dismantling` (`warehouseService.ts:2699-2717`) — не трогаем. Existing documents проводятся как раньше при перепроводке.

### PR 3 — множественные шаблоны на цех (БД + API)

**Миграция [backend-api/drizzle/00XX_workshop_repair_templates_multi.sql](../../backend-api/drizzle/):**

```sql
-- Текущая структура (миграция 0054):
--   workshop_id TEXT PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE
--   lines_json TEXT NOT NULL DEFAULT '[]'
--   updated_at BIGINT NOT NULL
--   updated_by TEXT

-- Новая структура:
ALTER TABLE workshop_repair_templates DROP CONSTRAINT workshop_repair_templates_pkey;
ALTER TABLE workshop_repair_templates ADD COLUMN id TEXT;
ALTER TABLE workshop_repair_templates ADD COLUMN name TEXT;

-- Backfill: для каждой существующей записи генерируем UUID и имя 'Базовый'.
UPDATE workshop_repair_templates
SET id = gen_random_uuid()::text,
    name = 'Базовый'
WHERE id IS NULL;

ALTER TABLE workshop_repair_templates ALTER COLUMN id SET NOT NULL;
ALTER TABLE workshop_repair_templates ALTER COLUMN name SET NOT NULL;
ALTER TABLE workshop_repair_templates ADD PRIMARY KEY (id);
CREATE INDEX workshop_repair_templates_workshop_idx ON workshop_repair_templates(workshop_id);
CREATE UNIQUE INDEX workshop_repair_templates_workshop_name_idx ON workshop_repair_templates(workshop_id, name);
```

**Drizzle schema [backend-api/src/db/schema.ts](../../backend-api/src/db/schema.ts):**

- Обновить `workshopRepairTemplates`: id PK, workshop_id FK, name unique within workshop.

**Service [backend-api/src/services/workshopRepairTemplateService.ts](../../backend-api/src/services/workshopRepairTemplateService.ts):**

- `listRepairTemplates(workshopId)` → `Array<{ id, workshopId, name, lines, updatedAt, updatedBy }>`.
- `getRepairTemplate(id)` → одна запись.
- `createRepairTemplate({ workshopId, name, lines }, actor)` → проверка уникальности name в пределах workshopId.
- `updateRepairTemplate(id, { name?, lines? }, actor)`.
- `deleteRepairTemplate(id, actor)`.

**Routes [backend-api/src/routes/workshops.ts](../../backend-api/src/routes/workshops.ts) или новый файл:**

- `GET /workshops/:workshopId/repair-templates` — список.
- `GET /workshops/:workshopId/repair-templates/:id` — одна.
- `POST /workshops/:workshopId/repair-templates` — создать.
- `PUT /workshops/:workshopId/repair-templates/:id` — обновить.
- `DELETE /workshops/:workshopId/repair-templates/:id` — удалить.

Старые routes `GET /workshops/:id/repair-template` и `PUT /workshops/:id/repair-template` — пометить deprecated (возвращают первый шаблон цеха). Удалить в следующем релизе.

### PR 4 — поле «Вид работы» в шаблоне и в наряде

**JSON структура lines (shared/types):**

```ts
// Сейчас:
type WorkshopRepairTemplateLine = {
  nomenclatureId: string;
  unit: string;
  defaultQty?: number;
};

// Новый:
type WorkshopRepairTemplateLine = {
  nomenclatureId: string;
  unit: string;
  defaultQty?: number;
  serviceId?: string;  // ← новое (опц.)
};
```

**Backend валидация** (`workshopRepairTemplateService.setRepairTemplate`):

- Если `serviceId` задан — проверить что услуга существует в `erp_directories.directory_kind = 'service'` (через `attribute_values`?) или в таблице services и не deleted.

**Autofill из шаблона в наряд** ([electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx](../../electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx) логика `applyTemplate`):

- `freeWorks[i].serviceId = templateLine.serviceId ?? null`.

**UI шаблона (WorkshopTemplateDialog.tsx):**

- Новая колонка «Вид работы» — SearchSelect по справочнику услуг.

**UI наряда (WorkOrderDetailsPage.tsx, Workshop-режим таблицы):**

- Показать колонку «Вид работы» (read-only из шаблона; editable если строка вне-шаблонная или для нового добавления).

### PR 5 — UI множественные шаблоны + ширина полей

**WorkshopTemplateDialog.tsx** (рефакторим под N шаблонов):

- Левая панель: список шаблонов цеха (имя + кол-во строк), кнопка `[+ Новый]`, `[Удалить]`.
- Правая панель: редактор выбранного шаблона (имя + таблица строк).
- Сохранение / отмена per-template.

**Кнопка `[Применить шаблон]` в наряде:**

- Открывает `WorkshopTemplatePickerDialog.tsx` — список шаблонов цеха для выбора. Клик → применяется к `freeWorks`, autosave наряда.

**Ширина полей:**

- В таблице наряда (`WorkOrderDetailsPage.tsx`, Workshop-режим):
  - «Деталь» (partName): расширить с текущей ширины до ~30% ширины таблицы (минимум 250px).
  - «Вид работы» (serviceName): ~20% ширины (минимум 180px).
  - Поджать «Ед.» / «Выпущено» / «Остаток» / «Итого».
- В таблице шаблона (`WorkshopTemplateDialog.tsx`): аналогично.

### PR 6 — release v1.27.0

- `node scripts/bump-version.mjs --set 1.27.0`.
- Запись в `RELEASE_WELCOME_HISTORY` ([shared/src/domain/releaseWelcome.ts](../../shared/src/domain/releaseWelcome.ts)).
- Запись в `docs/DEVELOPMENT_LOG.md`.
- PR → merge → tag → прод (включая `db:migrate` для миграции templates).

## Риски

- **Миграция templates** — DROP PK + ADD PK. На проде в таблице сейчас могут быть записи; backfill через `gen_random_uuid()` (PostgreSQL ≥13). Drop+Add в одной транзакции, downtime минимальный.
- **Поломка `repair_recovery` legacy документов** — после смены docType на `production_release` нельзя пересоздать старые наряды через ту же логику. Старые закрытые наряды не трогаем (immutable), их `documentId` указывает на уже посаженный `repair_recovery` документ. Re-post / сторнирование старых документов — отдельная операция, не задевается.
- **Existing `repair_fund` остатки** — на проде могут быть. После заморозки `engine_dismantling` они не пополняются, но и не убывают. UI показывает их (например, в отчётах) — не баг, информация для бизнеса.
- **Sync compat** — структура lines меняется (опц. поле `serviceId`). Старые клиенты не упадут — поле опциональное; они просто не покажут. После раскатки v1.27.0 у всех клиентов поле появится.

## Тестирование

- **PR 1:** unit-тест на pure-helper закрытия — для Repair и Workshop docType === 'production_release'. Integration-тест через verifier-electron (создать TEST-WORKSHOP → шаблон → наряд → закрыть → проверить что на склад цеха пришло, repair_fund не тронут).
- **PR 3:** integration-тест CRUD шаблонов (создание, переименование, удаление, уникальность name).
- **PR 4:** UI-тест autofill `serviceId` из шаблона в `freeWorks`.
- **Финал v1.27.0:** verifier-electron — полный flow с двумя шаблонами на цех, разными «Видами работы» в строках.
