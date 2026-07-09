# План: редактируемые акты комплектности/дефектовки + шаблоны по маркам

> Активный многоэтапный план (серия из 4 PR). Утверждён владельцем 2026-07-09. Рабочая копия согласования была в `~/.claude/plans/`; здесь — durable-версия в репо (видна на других компах).

## Context (зачем)

Владельцу не нравится, как выглядит **акт комплектности** (и по тому же принципу — **акт дефектовки**). Сейчас акты — жёстко зашитые статичные печатные HTML-строки:
- **Комиссия** — фиксированные 3 слота (начальник цеха / мастер / начальник ОТК), нельзя добавить/убрать.
- **«Состояние при поступлении»** — 5 захардкоженных пунктов (`ENGINE_RECEIPT_CONDITION_FIELDS`), нельзя убрать/добавить.
- **«Утверждаю: директор»** — только строчка-подпись внизу, не редактируемый гриф как у наряда.
- Поля ФИО/должность узкие — видно «только начало фамилии, а кто это — непонятно».
- Нет системы шаблонов, чтобы не забивать одно и то же для каждой марки заново.

Наряд сборки уже умеет всё это (редактируемый гриф «Утверждаю», add/remove подписантов с должностями, живой A4-предпросмотр в диалоге печати, именованные шаблоны в БД). **Задача — довести акты до того же уровня**, переиспользуя проверенные паттерны наряда.

Итог: акты редактируются как распечатка наряда; комиссия и «состояние при поступлении» — динамические списки; гриф «Утверждаю» редактируемый; поля ФИО/должность резиновые с всплывающей подсказкой полного текста; шаблоны актов сохраняются/применяются по марке двигателя.

## Решения владельца (при утверждении)
1. Гриф «Утверждаю» → правый верхний угол акта (как наряд), **заменяет** нижнюю подпись «Утверждаю: директор по качеству». Пресеты грифа — общие с нарядом + акт-дефолт «Директор по качеству».
2. Шаблоны — **именованные, несколько на марку** (unique `марка+имя`). Хранят шапку акта (комиссия/гриф/пункты состояния), **не** список деталей (он уже per-brand).
3. Живой A4-предпросмотр в диалоге печати — **опциональный PR5** (не в основной серии); основная серия — inline-редакторы в панели.

## Модель данных и ключевые решения

**Хранение (без изменений):** ответы акта — JSON `RepairChecklistPayload` в `operations.metaJson`, одна строка на (двигатель, stage=`engine_inventory`). Единая модель для акта комплектности и дефектовки (под-вкладки).

**Новые варианты `RepairChecklistAnswers`** (`shared/src/domain/repairChecklist.ts`), под 3 фиксированными ключами-НЕ-шаблонными (как уже сделан receipt-блок — bespoke-редакторы, вне generic-цикла `activeTemplate.items`):
- `commission_members` → `{ kind:'commission'; members: CommissionMember[] }`, `CommissionMember = { id; fio; position; signedAt: number|null; employeeId?; caption? }`.
- `receipt_condition_list` → `{ kind:'condition_list'; items: {id; label; value}[] }`.
- `approver_grif` → `{ kind:'approver'; grif: {preset?; positionOverride?; nameOverride?; employeeId?} }`.

**Гриф «Утверждаю» — переиспользуем SSOT наряда:** `WORK_ORDER_APPROVERS` / `resolveWorkOrderApprover` (`shared/src/domain/workOrder.ts:231-251`) — реальные пресеты (Директор / Технический директор, АО «Малмыжский РМЗ»). Добавлю акт-специфичный дефолт `quality` («Директор по качеству» — как печатается сейчас), чтобы не регрессировать. Редактор грифа портируется из `WorkOrderPrintDialog.tsx:288-357`.

**Ленивая миграция (обратная совместимость с прод-данными):** чистая детерминированная функция `migrateEngineInventoryAnswers(answers)` в shared — если новых ключей нет, засевает их из старых (3 слота комиссии → members с captions; 5 полей condition → items; `approved_by` → grif). **Стабильные derived-id** (не `randomUUID`), чтобы подпись снапшота была воспроизводимой. Запускается **лениво на загрузке панели** (`RepairChecklistPanel.tsx:751`), `setAnswers(migrated)` + прайминг `lastSavedAnswersRef` мигрированным снапшотом → **без авто-сейва** (легаси-ключи в БД остаются до первой реальной правки). НЕ мигрировать в `checklistService` read (снапшоты/история должны читаться байт-в-байт).

**Печать — критично:** `engineActSnapshotSignature` фризит **весь** `answers` в каждую напечатанную версию → старые версии не имеют новых ключей. Поэтому **все ридеры печати обязаны падать назад на легаси-ключи**: `getCommission` / `getConditionItems` / `getApproverGrif` (с fallback на `commission_*` / `receipt_*` / `approved_by`). Это #1 по риску.

**Шаблоны — именованные, много на марку** (unique `(engine_brand_id, name)`), близкая копия проверенного `work_order_templates`. Payload шаблона captures «шапку» акта (комиссия, гриф, список пунктов состояния — **без строк деталей**, они уже per-brand через `PartSpecBrandLink.inCompletenessAct/inDefectAct`).

## Фазы (4 независимо-выпускаемых PR)

### PR1 — Фундамент: резиновые поля + всплывающая подсказка (без смены модели)
- Новый компонент `electron-app/src/renderer/src/ui/components/OverflowTooltipInput.tsx` — без зависимостей: оборачивает `Input`, при `scrollWidth > clientWidth` и hover/focus показывает полупрозрачную плашку **над** полем (`position:absolute; bottom:100%; rgba(15,23,42,0.88)`, перенос по словам, `pointer-events:none`), пересчёт на изменение value/focus/hover.
- Редактор подписей (`RepairChecklistPanel.tsx:2031-2082`): должность → **редактируемый** `OverflowTooltipInput` (сейчас `disabled Input`); сетка `1fr 1fr 160px` → `minmax(0,1.1fr) minmax(0,1.4fr) 150px`. ФИО-`SearchSelect` тоже под tooltip.
- Receipt-блок (`:1935`): сетка шире (`minmax(120px,260px) 1fr`).
- Мелко, видимо, без миграций. Web-admin паритет — follow-up (флажок в PR).

### PR2 — Динамическая комиссия (add/remove с должностями)
- `kind:'commission'` + `migrateEngineInventoryAnswers` (арм комиссии) + прайминг `lastSavedAnswersRef` на загрузке.
- Bespoke-редактор комиссии (модель — динамический список `defect_dismantled_by`, `:1863-1931`): строки ФИО-`SearchSelect` (заполняет fio+position) · редактируемая должность `OverflowTooltipInput` · дата · «Удалить»; полноширинный caption (роль); «+ Добавить члена комиссии».
- Переписать авто-подстановку (`:870-907`) и `fillCommissionByWorkshop` (`:912-951`) на `commission_members`.
- Печать: `getCommission(answers)` с легаси-fallback + режим пустого бланка (посев members + пара пустых слотов). Оба акта.

### PR3 — Редактируемый список «Состояние при поступлении» + гриф «Утверждаю»
- `kind:'condition_list'` + `kind:'approver'` (+ армы миграции).
- Редактор состояния: rename/add/remove пунктов (замена фикс-блока `:1932-1966`).
- Редактор грифа (порт `WorkOrderPrintDialog.tsx:288-357`): пресет (Директор/Тех.директор/Кач-во) + выбор сотрудника + override должности.
- Печать: гриф «Утверждаю» в правом верхнем углу **обоих** актов (как наряд, CSS в `COMMON_STYLES`), динамический список состояния; убрать нижнюю подпись `approved_by`.

### PR4 — Шаблоны актов по маркам (сохранить/применить как у нарядов)
- Схема: таблица `engine_act_templates` (`backend-api/src/database/schema.ts` рядом с `workOrderTemplates:952-968`), unique `(engine_brand_id, name)`; миграция **`0074_engine_act_templates.sql`** (последняя в репо — 0073) по образцу `0056_work_order_templates.sql` + запись в `meta/_journal.json`.
- Shared: `shared/src/domain/engineActTemplate.ts` (DTO/Summary/валидатор, payload = `{commissionMembers, approverGrif, conditionItems(labels)}`), экспорт из barrel; permission `engine_act_templates.edit` в `permissions.ts`.
- Backend: `engineActTemplateService.ts` (list/get/create/update/delete + dup-name), REST `routes/engineActTemplates.ts` (mount в app), IPC `ipc/register/engineActTemplates.ts` (+ `registerIpc.ts` ~34/160), preload `window.matrica.engineActTemplates.*` + d.ts.
- Apply: чистая `applyEngineActTemplate(answers, tpl)` (заменяет только комиссию/гриф/состояние, сохраняя текущие values состояния по id; НЕ трогает таблицу деталей). Кнопка «Применить шаблон марки» на под-вкладке комплектности; авто-применение при пустой комиссии (гейт от перезатирания заполненного).

## Ключевые файлы
- `shared/src/domain/repairChecklist.ts` — новые варианты union + `migrateEngineInventoryAnswers` + акт-пресет `quality`.
- `electron-app/src/renderer/src/ui/components/RepairChecklistPanel.tsx` — миграция на загрузке (751), редакторы, взаимодействие save/brand-resync (870-951, 1145-1323, 1932-2082).
- `electron-app/src/renderer/src/ui/utils/engineInventoryPrintHtml.ts` — ридеры с легаси-fallback + рендер комиссии/состояния/грифа (113-119, 216-220, 271-289, 362-376).
- `electron-app/src/renderer/src/ui/components/OverflowTooltipInput.tsx` — новый.
- PR4: `backend-api/src/database/schema.ts`, `backend-api/drizzle/0074_*.sql`, `engineActTemplateService.ts`, `routes/engineActTemplates.ts`, `ipc/register/engineActTemplates.ts`, `shared/src/domain/engineActTemplate.ts` (образцы — `workOrderTemplate*`).

## Переиспользуемое (не писать заново)
- Динамический список сотрудников — `RepairChecklistPanel.tsx:1863-1931` (`defect_dismantled_by`).
- Редактор грифа «Утверждаю» + пресеты — `WorkOrderPrintDialog.tsx:288-357`, `workOrder.ts:231-251`.
- Add/remove-строки подписантов — `WorkOrderDetailsPage.tsx:1897-2008`.
- Вся подсистема именованных шаблонов — `workOrderTemplate*` (domain/service/route/ipc) + прецедент `migrateWorkshopTemplatesToWorkOrderTemplates.ts`.
- `SearchSelect`, `Input`, `Button`, `RowReorderButtons` — готовые общие компоненты.

## Риски
- **Фризнутые снапшоты** — легаси-fallback во всех ридерах печати (иначе старые версии печатаются пустыми). Миграция строго **детерминирована** (derived-id, стабильный порядок ключей) — иначе паразитный bump версий снапшота.
- **Debounced save/queue** (`saveInFlightRef`/`queuedSaveAnswersRef`/`lastSavedAnswersRef`) — не звать `save()` из миграции; прайминг ref мигрированным снапшотом.
- **Brand-resync** (1145-1323) спредит `...answers` → новые ключи переживают; убедиться, что миграция уже отработала на загрузке.
- **web-admin паритет** — тамошний `RepairChecklistPanel` игнорит неизвестные `kind` (safe); полное редактирование — опц. follow-up.
- **exactOptionalPropertyTypes** — `employeeId/caption/preset/*Override` через conditional spread; `signedAt` держим `number|null`.
- **PR4 plumbing** — IPC в `registerIpc.ts`, router в app, preload d.ts, permission роли — каждый слой падает молча, проверить все.

## Верификация (каждый PR)
- Гейты (CLAUDE.md §Autonomy): build `shared`+`ledger` → `pnpm -r typecheck` (по пакетам, гонка dist) → `lint` → `backend-api test`.
- **CDP e2e** (`verifier-electron`, skill `verify`) — драйв карточки двигателя → под-вкладки актов: добавить/убрать члена комиссии и пункт состояния, выбрать грифа, проверить резиновость полей + всплывающую подсказку на длинном ФИО; напечатать акт (комплектность+дефектовка), проверить бланк.
- **Печать pure-билдером** (как `scratchpad/check-print.mjs`) — снять HTML для: заполненного акта, пустого бланка, и **легаси-снапшота без новых ключей** (fallback обязателен).
- PR4: применить шаблон марки к свежему двигателю → комиссия/гриф/состояние заполнились; проверить unique-имя, list/apply.
- Деплой — отдельным `/reliz` по готовности серии (не часть каждого PR).

## Статус
- [ ] PR1 — резиновые поля + всплывающая подсказка
- [ ] PR2 — динамическая комиссия
- [ ] PR3 — состояние при поступлении + гриф «Утверждаю»
- [ ] PR4 — шаблоны актов по маркам
- [ ] (опц.) PR5 — живой A4-предпросмотр в диалоге печати
