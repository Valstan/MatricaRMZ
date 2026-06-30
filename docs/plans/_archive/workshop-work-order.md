# Workshop Work Order — пятый тип наряда «Ремонт по шаблону цеха»

Версия плана: 2026-05-26
Инициирован: пользователь, после раскатки v1.25.0
Preempted by: [нет — новая нитка]

## Бизнес-контекст

4-й цех (а в будущем — другие цеха) ремонтирует широкий список типовых деталей: гильзы всех размеров, рубашки всех типов, поршни всех типов и т.д. Сейчас оператор вручную добавляет каждую деталь в наряд через «Тип `Ремонт`» — много кликов на повторяющийся список.

Нужно: **шаблон-driven наряд**, который при создании сразу заполняется списком деталей цеха из настраиваемого оператором шаблона. Оператор только проставляет «выпустил столько-то» в каждой строке.

## Цели

1. Новый 5-й тип наряда `WorkshopTemplate` (UI «Ремонт по шаблону цеха») в модалке создания.
2. Per-workshop шаблон: список (`nomenclatureId`, `unit`, опц. `defaultQty`). Хранится в БД, редактируется через UI.
3. При создании Workshop-наряда — `freeWorks` автогенерируется из шаблона выбранного цеха.
4. В таблице наряда новые колонки: `Деталь` / `Ед.` / `Выпущено` / `Остаток в цеху` (live из stock_balances) / `Итого после` (= остаток + выпущено).
5. При закрытии — приходный складской документ `repair_recovery` (как у текущего Repair наряда) — выпущенные детали поступают на склад цеха.
6. Кнопка «Шаблон» в шапке открытого наряда → диалог редактирования шаблона текущего цеха.

## Решённые развилки (зафиксированы 2026-05-26 пользователем)

- ✅ Шаблон **per-workshopId** (не глобальный) — гибкость на будущие цеха без правки кода.
- ✅ Кнопка «Шаблон» — **в шапке открытого Workshop-наряда** (рядом с «Цех» / «Тип»). Открывает диалог редактирования шаблона текущего цеха.
- ✅ Название 5-го типа в UI: **«Ремонт по шаблону цеха»** (`WorkOrderKind.WorkshopTemplate = 'workshop_template'`).
- ✅ Закрытие наряда **проводит приход на склад цеха** (как Repair/Manufacturing) — выпущенные детали поступают на склад цеха автоматически. Дальнейшее перемещение — через существующие документы «Перенос/Перемещение».
- ✅ **Прунинг пустых строк при проводке** — на «Закрыть и провести» строки с `qty <= 0` (или невалидным qty) автоматически удаляются из `freeWorks`. В закрытом наряде остаются только реально выпущенные позиции. До проводки (drafts / autosave) — все строки шаблона сохраняются как есть; оператор видит весь список и заполняет постепенно.

### Дополнительно зафиксировано 2026-05-26 (PR 1, после прочтения кода)

- ✅ **Batch endpoint остатков** — `POST /warehouse/stock-balances/by-workshop` с body `{ workshopId, nomenclatureIds: string[] }` → `{ [nomenclatureId]: { onHand: number } }`. **Новый**, не переиспользование. В существующем коде нет batch-аналога: `claudeTools.getStockBalances` принимает один `nomenclatureId`. POST вместо GET — список IDs может быть длинным (>2000 chars URL).
- ✅ **Модалка создания наряда НЕ спрашивает workshopId** — проверено в [`WorkOrdersPage.tsx:177-210`](../../electron-app/src/renderer/src/ui/pages/WorkOrdersPage.tsx). `createWithKind(kind)` создаёт пустой наряд и сразу патчит `workOrderKind`, без выбора цеха. **Следствие:** autofill шаблона происходит **в карточке наряда** (`WorkOrderDetailsPage`), не в модалке создания:
  - При первой установке `workshopId` в Workshop-наряде **с пустым `freeWorks`** — backend (или клиент) подтягивает шаблон выбранного цеха и заполняет `freeWorks` строками (`partId=nomenclatureId`, `qty=defaultQty ?? 0`, `unit`).
  - Если `freeWorks` уже не пуст или `workshopId` меняется (а не устанавливается впервые) — **не перетирать автоматически**. Есть ручная кнопка `[Применить шаблон цеха]` рядом с `[Шаблон]` — fallback для оператора. По [[feedback-data-integrity-over-convenience]]: явный > неявный, нельзя терять данные.
- ✅ **Пустой шаблон цеха при создании Workshop-наряда** — пустой наряд + status-toast «Шаблон цеха «{наименование}» пуст. Настройте через кнопку «Шаблон»». Кнопка `[Шаблон]` в шапке доступна сразу после установки `workshopId` — оператор настраивает шаблон, потом нажимает `[Применить шаблон]`.
- ✅ **Editable `partId` в Workshop-строке** — **нет**. Строки из шаблона — read-only по `partId`/`partName`/`unit` (только `qty` editable). Защита от случайного изменения «деталь шаблона» в процессе работы. Удалить строку шаблона нельзя — оператор оставляет `qty=0`, при проводке она сама удалится через `pruneEmptyWorkshopLines`. Кнопка `[+ Добавить строку]` позволяет добавить **вне-шаблонную** строку (полноценный SearchSelect номенклатуры) — её можно удалить вручную как обычно.
- ✅ **Permission редактирования шаблона** — **новая** `WorkshopRepairTemplatesEdit: 'workshop_repair_templates.edit'`, `adminOnly: true`. Аргумент: семантически отличается от `WorkshopsManage` (тот про справочник цехов — создать/переименовать), а шаблон ремонта — про **что цех делает**. Также строже чем `WorkOrdersEdit` — одна правка шаблона влияет на все будущие наряды цеха, нельзя давать оператору. GET (чтение) — **без отдельной permission**, доступен любому с `WorkOrdersCreate` (нужно для autofill).

## Архитектура

### Shared (`shared/src/domain/workOrder.ts`)

- Добавить в `WorkOrderKind`: `WorkshopTemplate: 'workshop_template'`.
- `WORK_ORDER_KIND_LABELS[WorkshopTemplate]` = `'Ремонт по шаблону цеха'`.
- `WORK_ORDER_KIND_DESCRIPTIONS[WorkshopTemplate]` = `'Список деталей из шаблона цеха. При закрытии выпущенные детали поступают на склад цеха автоматически.'`.
- `WORK_ORDER_KIND_ORDER` — добавить после `Repair`.
- Пройти все switch'и по `WorkOrderKind` в коде — exhaustiveness check.

### Backend (PostgreSQL + Drizzle)

**Новая таблица `workshop_repair_templates`** (миграция `backend-api/drizzle/00XX_workshop_repair_templates.sql`):

```sql
CREATE TABLE workshop_repair_templates (
  workshop_id TEXT PRIMARY KEY REFERENCES workshops(id) ON DELETE CASCADE,
  lines_json TEXT NOT NULL DEFAULT '[]',  -- JSON: [{nomenclatureId, unit, defaultQty?}, ...]
  updated_at BIGINT NOT NULL,
  updated_by TEXT
);
```

**Не подключать к sync** — шаблон централизован на бэкенде, клиенты тянут через REST (паттерн как у `services`).

**Routes** (`backend-api/src/routes/workshops.ts` или новый `workshopRepairTemplates.ts`):

- `GET /workshops/:id/repair-template` → `{ workshopId, lines: [...] }`.
- `PUT /workshops/:id/repair-template` → save lines (валидация: `nomenclatureId` существует и не deleted, `unit` non-empty).

**Service** (`backend-api/src/services/workshopRepairTemplateService.ts`):

- `getRepairTemplate(workshopId)` → fetch + parse JSON.
- `setRepairTemplate(workshopId, lines, actor)` → upsert.

### Backend — закрытие наряда

В `workOrderClosingService.ts` добавить ветку для `WorkshopTemplate`:

- **Прунинг пустых строк (на проводке)**: перед составлением `producedLines` отфильтровать `freeWorks` — оставить только строки с `Number(qty) > 0` (и валидным `partId`). Невалидные/нулевые строки **удаляются из `payload.freeWorks`** перед сохранением закрытого наряда. То есть закрытый Workshop-наряд содержит только реально выпущенные позиции. Логика — pure-функция `pruneEmptyWorkshopLines(payload)` в shared, переиспользуется в тестах и UI (если потребуется preview перед закрытием).
- `docType = 'repair_recovery'` (переиспользуем — семантика та же: «отремонтированные детали → на склад цеха»).
- `producedLines` собираются из **отфильтрованных** `freeWorks` (каждая строка с `partId` → `nomenclatureId`, `qty`).
- `targetWarehouseId` = склад выбранного цеха (тот же что для текущего Repair).
- **Edge case**: если после прунинга `freeWorks.length === 0` — отказать в закрытии с понятным сообщением «Заполните количество хотя бы в одной строке наряда». Не создавать пустой `repair_recovery` документ.

### Frontend (electron-app)

**Preload IPC** (`electron-app/src/preload/index.ts`):

- `workshops.getRepairTemplate(workshopId)` → `{ workshopId, lines }`.
- `workshops.setRepairTemplate({ workshopId, lines })` → ok/error.

**Создание наряда** (`WorkOrdersPage.tsx` модалка):

- Добавить 5-й вариант в модалку выбора типа (уже использует `WORK_ORDER_KIND_ORDER`, после расширения shared автоматически появится).
- При выборе `WorkshopTemplate`: после `createWorkOrder` + получения нового `id` — сразу подтянуть шаблон **выбранного цеха** через `workshops.getRepairTemplate(workshopId)`, заполнить `payload.freeWorks` строками из шаблона (`partId=nomenclatureId`, `qty=defaultQty ?? 0`, `unit`), сохранить через `updateWorkOrder`. Открыть карточку.
  - **Тонкость**: шаблон загружается ПОСЛЕ выбора цеха. Возможно надо в модалке сначала спросить цех (как при создании Repair/Assembly). Уточнить — модалка уже спрашивает workshopId перед созданием?

**Карточка наряда** (`WorkOrderDetailsPage.tsx`):

- При `payload.workOrderKind === WorkshopTemplate`:
  - В шапке после селектора «Тип» — кнопка `[Шаблон]` (открывает диалог).
  - Колонки таблицы `freeWorks` — переключаются на специальный режим:
    - Скрыть: `Услуга`, `Цена`, `Сумма`.
    - Показать: `Деталь` (= partName, read-only из шаблона), `Ед.` (= unit, read-only), `Выпущено` (= qty, editable), `Остаток в цеху` (live load), `Итого после` (= остаток + qty, computed).
- Кнопка «+ Добавить строку» — оставить, оператор может вне-шаблонно добавить деталь.

**Диалог шаблона** (`WorkshopTemplateDialog.tsx`):

- Открывается с `workshopId`.
- Загружает текущий шаблон через `workshops.getRepairTemplate`.
- Таблица: `Номенклатура` (SearchSelect из всех номенклатур), `Ед.` (input, default «шт»), `defaultQty` (input number, опц.).
- Кнопки добавить/удалить строку, drag-reorder (опц.).
- «Сохранить» → `workshops.setRepairTemplate`.

**Live остатки в наряде**:

- Новый IPC `warehouse.stockBalanceForWorkshop({ workshopId, nomenclatureIds })` → `{ [nomenclatureId]: { onHand: number } }`.
- В `WorkOrderDetailsPage.tsx` — при загрузке Workshop-наряда подтянуть batch остатки для всех `partId` строк → отрендерить колонку.
- Refresh остатков по `payload.workshopId` смене либо ручной кнопкой `[Обновить остатки]`.

## Этапы (предлагаемая разбивка PR)

1. **PR 1 (shared)** — `WorkOrderKind.WorkshopTemplate`, labels, descriptions, order. Без UI и BE. Unit-тесты на exhaustiveness.
2. **PR 2 (backend DB + routes)** — миграция `workshop_repair_templates`, service, routes `GET/PUT /workshops/:id/repair-template`. Integration-тест.
3. **PR 3 (backend closing)** — ветка `WorkshopTemplate` в `workOrderClosingService.ts`: pure-helper `pruneEmptyWorkshopLines` в shared + переиспользование `repair_recovery` логики. Тесты в `workOrderClosing.test.ts` (prune empty, empty-after-prune error, normal flow).
4. **PR 4 (electron preload + диалог шаблона)** — IPC `workshops.getRepairTemplate/setRepairTemplate`, `WorkshopTemplateDialog.tsx`, доступ через кнопку «Шаблон» (можно в `AdminPage` как временный entry-point).
5. **PR 5 (electron — модалка создания + autofill)** — 5-й тип в `WorkOrdersPage` модалке, после `createWorkOrder` подтягивается шаблон цеха, `freeWorks` заполняется.
6. **PR 6 (electron — UI карточки наряда)** — кнопка «Шаблон» в шапке Workshop-наряда, спец-колонки таблицы (Деталь/Ед./Выпущено/Остаток/Итого), live остатки.
7. **Release v1.26.0** — bump + releaseWelcome + tag + прод-деплой (включая `db:migrate`).

## Открытые вопросы (1–5 разрешены 2026-05-26 — см. § «Дополнительно зафиксировано»; 6 — план тестирования)

1. ✅ **`stockBalanceForWorkshop` batch endpoint** — новый, `POST /warehouse/stock-balances/by-workshop`. См. развилки выше.
2. ✅ **Модалка создания наряда не спрашивает workshopId** — autofill происходит в карточке при первой установке `workshopId`. См. развилки выше.
3. ✅ **Пустой шаблон цеха** — пустой наряд + status-toast. См. развилки выше.
4. ✅ **partId в Workshop-строке** — read-only из шаблона, кнопка `[+ Добавить строку]` для вне-шаблонной позиции. См. развилки выше.
5. ✅ **Permission** — новая `WorkshopRepairTemplatesEdit` (adminOnly). См. развилки выше.
6. **Тестирование** — verify через verifier-electron skill: создать TEST-WORKSHOP с шаблоном из 2 номенклатур → создать Workshop-наряд для этого цеха → проверить autofill, остатки, закрытие → проверить что `repair_recovery` документ создался.

## Риски

- **Размер фичи** — 6 PR'ов, ~пол-дня работы. Лучше пройти plan-mode в новой сессии и разбивать в один-два PR за раз.
- **Live остатки** — batch-запрос остатков на каждое открытие наряда может быть медленным при большом шаблоне. Кэширование на клиенте + invalidate on workshopId change.
- **Sync compat** — новый `workOrderKind='workshop_template'` должен быть в whitelist у старых клиентов (`isWorkOrderKind` в shared уже centralized — добавить туда). При sync push старых клиентов backend не должен падать на неизвестном kind.
- **Шаблон не sync-table** — изменения шаблона не идут в ledger. Это намеренно (как `services`), но значит **другая машина пока админ её не PUT-нет с этой машины** имеет stale шаблон в кэше. UI должен fresh-fetch'ить при открытии диалога.
