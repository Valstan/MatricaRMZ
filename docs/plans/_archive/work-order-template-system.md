# Универсальная система шаблонов нарядов (post-v1.27.1)

Версия плана: 2026-05-26
Инициатор: пользователь, после первого использования v1.27.0
Preempted by: [нет — новая нитка, после v1.27.1 hotfix]

## Контекст

В v1.26.0 добавлен 5-й тип наряда `WorkOrderKind.WorkshopTemplate` — наряд «по шаблону цеха» со специальной логикой autofill, отдельным БД-объектом (`workshop_repair_templates`), отдельным UI и backend-веткой closing. В v1.27.0 шаблон стал множественным (1:N per цех) + появилось поле «Вид работы» в строке шаблона. После первого реального использования пользователь заметил:

1. **`serviceId` mapping bug** — закрыт hotfix'ом v1.27.1.
2. **Шаблонизация Workshop — частный случай общей идеи**: «удобно бы было иметь это для всех типов нарядов». Например, для регулярных нарядов 4-го цеха оператор каждый день заполняет одни и те же поля и оставляет пустыми те же самые поля. Поля никуда не девались — наряд хранит их в payload — но в UI они мешают и отвлекают.

Пользователь предложил откатить тип `WorkshopTemplate` и сделать **универсальную систему шаблонов** для всех 4 базовых типов нарядов.

## Целевая архитектура

### 4 типа нарядов (без WorkshopTemplate)

1. **Regular** — без складских движений, только зарплата.
2. **Repair** — приход отремонтированных деталей на склад цеха (как «новые», через `production_release`). В будущем — перевод деталей из ремфонда на склад цеха.
3. **Assembly** — списание со склада цеха на конкретный двигатель.
4. **Manufacturing** — приход новых деталей на склад цеха-изготовителя.

### Шаблон наряда

Шаблон — это **сохранённый снимок «как заполняется наряд» + флаги видимости полей**. Привязан к одному из 4 типов нарядов (зафиксировано пользователем). Применение шаблона к открытому наряду:

1. Копирует значения предзаполненных полей в payload наряда.
2. Копирует строки `freeWorks` шаблона в `payload.freeWorks` (replace или append — UX-решение в задаче 5).
3. Сохраняет в локальный state карточки **набор скрытых полей** — они не показываются в UI, но в БД остаются как обычные `null`-поля. Скрытие — visual-only.

Скрытие — **Soft hide (collapsed)**: спрятанные поля группируются в раскрывающийся блок «Дополнительные поля (N скрыто)». Оператор может его раскрыть и заполнить если нужно в исключении.

## Схема БД

Новая таблица — общая для всех 4 типов:

```sql
CREATE TABLE work_order_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_kind text NOT NULL CHECK (work_order_kind IN ('regular','repair','assembly','manufacturing')),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  /** payload_overrides — частичный snapshot WorkOrderPayload: поля которые предзаполняются */
  payload_overrides jsonb NOT NULL DEFAULT '{}',
  /** hidden_fields — массив строк, ключи скрываемых полей payload (e.g. ["engineId","contractNumber"]) */
  hidden_fields jsonb NOT NULL DEFAULT '[]',
  /** lines — массив строк freeWorks (та же структура что в WorkOrderPayload.freeWorks) */
  lines         jsonb NOT NULL DEFAULT '[]',
  updated_at    bigint NOT NULL,
  updated_by    text,
  CONSTRAINT work_order_templates_kind_name_uq UNIQUE (work_order_kind, name)
);

CREATE INDEX work_order_templates_kind_idx ON work_order_templates (work_order_kind);
```

Старая таблица `workshop_repair_templates` остаётся (read-only legacy, archived). Использовать её больше не будем — миграция перенесёт записи в `work_order_templates`.

## Миграция existing данных

### Шаблоны цеха (`workshop_repair_templates`)

Для каждой строки старой таблицы:
- `work_order_kind = 'repair'` (потому что Workshop по бизнес-смыслу = Ремонт с предзаполненным списком деталей).
- `name = `${workshopName} — ${oldName}`` (чтобы было видно происхождение).
- `payload_overrides = { workshopId: <old.workshop_id> }` (привязка к цеху).
- `hidden_fields = [ "engineId", "engineNumber", "engineBrandId", "engineBrandName", "productNumber" ]` (то что в Workshop-режиме было неактуально).
- `lines = <transformed lines>` (структура та же — добавятся nulls для полей которых не было).

### Существующие Workshop-наряды (`operations` с `workOrderKind = 'workshop_template'`)

Это самое деликатное. На проде сейчас может быть N Workshop-нарядов. После рефакторинга `WorkOrderKind` enum не должен содержать `'workshop_template'`.

Решения:
- **Открытые наряды (status != closed):** скриптом перевести `workOrderKind` → `'repair'`, в `metaJson` пометить `migratedFromWorkshopTemplate: true` для аудита. Применённый шаблон **не восстанавливаем** — оператор продолжит редактировать как обычный Repair-наряд. freeWorks/workshopId сохраняются.
- **Закрытые наряды:** оставить `workOrderKind = 'workshop_template'` как историческое значение. В UI карточка таких нарядов — read-only (всегда), просто метка типа отображается «Ремонт по шаблону (legacy)». Backend `WorkOrderKind` enum держит deprecated-значение для парсинга legacy записей, но новые наряды этот kind не получают.
- **Документы `production_release` с docNoPrefix='WSR'** — остаются как есть. Это историческая запись, она immutable.

## API (новые routes)

```
GET    /work-order-templates                           — list (опц. ?kind=repair)
GET    /work-order-templates/:id                       — get
POST   /work-order-templates                           — create
PUT    /work-order-templates/:id                       — update
DELETE /work-order-templates/:id                       — delete
POST   /work-order-templates/:id/apply                 — (опц.) серверный hint apply,
                                                          но UX-применение делает фронт сам
```

Permissions: `work_order_templates.edit` (admin) для POST/PUT/DELETE. `work_orders.create` (operator) для GET.

Старые routes `/workshops/:id/repair-templates(/:tid)` помечаем deprecated, удаляем через релиз.

## UI

### Меню «Наряды»

Появляются две кнопки рядом:
- **«Создать наряд»** — как сейчас, открывает modal выбора типа → создаёт пустой наряд.
- **«Шаблоны нарядов»** — открывает страницу/диалог управления шаблонами всех типов. Список с фильтром по типу.

### Карточка любого наряда

- Поле выбора шаблона (dropdown по шаблонам того же типа что наряд).
- Кнопка **«Применить выбранный шаблон»** — копирует overrides+lines в payload, активирует hidden_fields.
- Кнопка **«Редактировать шаблоны»** — открывает редактор шаблонов (тот же что в меню).
- Скрытые поля группируются под раскрывающимся блоком «Дополнительные поля (N скрыто)».

### Редактор шаблона

Левая панель — список шаблонов выбранного типа. Правая — редактор:
- Имя шаблона.
- Все поля карточки наряда в режиме «редактирования шаблона»: каждое имеет чекбокс «Скрыть в наряде» + само значение (если оператор хочет предзаполнить).
- Таблица строк (свободные работы) с возможностью добавлять/удалять/менять порядок.
- Сохранение per-template (POST/PUT).

## Этапы реализации

### PR 1 — shared types + миграция БД

- `shared/src/domain/workOrderTemplate.ts` — типы `WorkOrderTemplateDto`, `WorkOrderTemplateSummary`, `WorkOrderTemplateFieldVisibility`.
- `backend-api/drizzle/0056_work_order_templates.sql` — новая таблица.
- `backend-api/src/db/schema.ts` — entry `workOrderTemplates`.
- Скрипт миграции `scripts/migrateWorkshopTemplatesToWorkOrderTemplates.ts` с dry-run / apply: переносит `workshop_repair_templates` → `work_order_templates` (kind=repair).

### PR 2 — backend сервис + routes

- `workOrderTemplateService.ts` — CRUD + валидация (включая проверку `work_order_kind ∈ enum`).
- `workOrderTemplatesRouter` в `routes/workOrderTemplates.ts` + регистрация в `app.ts`.
- `routes/workshops.ts` — старые `/repair-templates` помечены deprecated (warning header), физически не удалены.
- `PermissionCode.WorkOrderTemplatesEdit` (новое право, отдельно от старого WorkshopRepairTemplatesEdit).
- Тесты сервиса (15-20 unit).

### PR 3 — IPC bridge

- `preload/index.ts` — секция `workOrderTemplates` с list/get/create/update/delete.
- `main/ipc/register/workOrderTemplates.ts` — handlers.
- `shared/ipc/types.ts` — типы MatricaApi.workOrderTemplates.

### PR 4 — UI: страница «Шаблоны нарядов» + редактор

- `pages/WorkOrderTemplatesPage.tsx` — список с фильтром по типу + CRUD.
- `components/WorkOrderTemplateEditorDialog.tsx` — редактор шаблона (имя + флажки скрытия per-field + предзаполнение + строки).
- Меню Наряды → новая ссылка «Шаблоны нарядов» рядом с «Создать наряд».

### PR 5 — UI: интеграция в карточку наряда

- `WorkOrderDetailsPage.tsx`:
  - dropdown выбора шаблона (фильтр по `payload.workOrderKind`).
  - кнопки `[Применить шаблон]`, `[Редактировать шаблоны]`.
  - `applyTemplate(templateId)` — копирует overrides + lines в payload, активирует hidden_fields.
  - Все рендеры полей карточки проверяют `hiddenFields.has(fieldKey)` → группируют под collapsed-блоком «Дополнительные поля».
- Старые Workshop-кнопки (`[Шаблон]`, `[Применить шаблон]` от v1.26.0/1.27.0) удалить.

### PR 6 — миграция данных + удаление WorkOrderKind.WorkshopTemplate

- Прогон скрипта миграции на прод dry-run → apply (миграция 0056 + перенос данных).
- В `shared/src/domain/enums.ts` пометить `WorkOrderKind.WorkshopTemplate` как `@deprecated`, **не убирать из enum** (legacy operations его используют).
- Скрипт `scripts/migrateExistingWorkshopOrders.ts` — конвертирует открытые наряды в Repair.
- Закрытые наряды остаются с `'workshop_template'` kind.
- `WorkOrderKindPickerDialog` — убрать из списка для новых нарядов.

### PR 7 — релиз v1.28.0

- Bump, RELEASE_WELCOME_HISTORY entry «универсальные шаблоны нарядов», DEVELOPMENT_LOG.

## Риски и открытые вопросы

### Риски

- **Hidden fields в payload** — поля остаются `null/empty` в БД. Если кто-то в БД смотрит наряды напрямую, заметит пропуски. Это OK для бизнес-смысла, но требует пометки в README.
- **Не все поля можно скрыть** — некоторые валидируются (например, `workshopId` для не-Regular). Hidden-флаг для них должен быть запрещён. Закодировать список «обязательных полей per kind» в shared.
- **Удаление шаблона** — что с уже созданными по нему нарядами? Ничего: шаблон применён один раз при создании, дальше наряд живёт своей жизнью. Удаление шаблона — это только закрытие источника для будущих apply.
- **Sync compat** — `work_order_templates` нужна в sync-протоколе. Добавить в `shared/src/sync/erpTables.ts` и `erpDto.ts`.

### Открытые вопросы (на решение в начале нитки)

1. **Поля для скрытия — closed enum или open `Record<string, boolean>`?** Closed = безопаснее (валидация), но требует ручного перечисления всех keys. Open = гибче.
2. **Replace vs append при apply?** Если в наряде уже есть строки, что делать с `template.lines`? Confirm + replace? Confirm + append? Конфигурируемо в шаблоне?
3. **Шаблоны видны всем или per-user?** Скорее всего, всем (это правило цеха, не персональное предпочтение). Подтвердить.
4. **«Скрыть» внутри редактора шаблона** — UX-вид: чекбокс на каждое поле, или раскладка «доступные / скрытые» с переключением?

## Зачем мы это делаем (для будущих сессий)

- v1.26.0 вычленила специфическую механику Workshop-template; v1.27.0 расширила её. Это движение в сторону универсального шаблонирования, но через **частный случай (5-й тип наряда)**.
- Пользователь увидел, что общая идея применима к любому типу наряда. Лучше иметь одну универсальную систему, чем второй и третий «X-by-template» kind.
- Это **упрощение** кодовой базы (один тип шаблона вместо нескольких) ценой одной разовой миграции.

## Связанные документы

- [Workshop-work-order v1.26.0 план](workshop-work-order.md) — исходная нитка про WorkOrderKind.WorkshopTemplate.
- [Workshop-template-fixes v1.27.0 план](workshop-template-fixes.md) — multi-templates + «Вид работы».
- v1.27.1 hotfix — запись в [DEVELOPMENT_LOG.md](../DEVELOPMENT_LOG.md).
