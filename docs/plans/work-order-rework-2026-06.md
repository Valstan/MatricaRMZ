# Work-order rework + Ramzia isolation — 2026-06

> Источник: две скоординированные директивы brain (06-30, `compliance: recommend`):
> [`naryad-card-completion-button-dates`](../../mailbox/to-brain/2026-06-30-ledger-audit-and-0630-batch-intake.md) (карточка: кнопка «выполнен» + 4 даты + список-колонки/поиск) и
> [`naryad-list-filter-roles-isolation`](../../mailbox/) (список: фильтр по типу + **ролевая изоляция нарядов Рамзии на sync-границе**).
> Письма требуют **одной** доработки списка (не два прохода) и для части B — **recon ДО дизайна**, серверный энфорс (#063), adversarial-review + verify под обеими ролями.

## Recon-итог (что есть в коде — с file:line)

**Данные наряда:** `operations` (PG), весь payload — JSON `operations.metaJson`; тип в `payload.workOrderKind` (regular/repair/assembly/manufacturing/workshop_template[legacy]). 4 даты — все в payload: `orderDate` (auto, immutable), `startDate`, `dueDate`, `completedDate`. Колонки владельца на строке **нет** (`operations.performedBy` — text, «кто выполнил», не создатель).
- [`shared/src/domain/workOrder.ts:237`](../../shared/src/domain/workOrder.ts) — `WorkOrderPayload` (v4, даты optional).
- [`backend-api/src/database/schema.ts:94`](../../backend-api/src/database/schema.ts) — `operations`; [:130](../../backend-api/src/database/schema.ts) — **`row_owners`** (generic: `{tableName,rowId,ownerUserId,ownerUsername}`, уник (table,row)).

**Проводка:** [`workOrderClosingService.ts:322`](../../backend-api/src/services/workOrderClosingService.ts) `closeWorkOrderAndPostDocument` — **идемпотентна** (guard :353 по `status='closed'`+`linkedDocumentId`), но **не полностью атомарна** (create→plan→post последовательны; при сбое post — orphaned-документ). Assembly — двухшаговый (`save-assembly-draft` резервирует → `post-assembly` списывает), routes [`workOrders.ts:61`](../../backend-api/src/routes/workOrders.ts).

**UI список** [`WorkOrdersPage.tsx`](../../electron-app/src/renderer/src/ui/pages/WorkOrdersPage.tsx): 4 даты **уже** сортируемые колонки (:288–322), тогл видимости (`ColumnSettingsButton`), серверный поиск `q` (:113). **Нет** инлайн-фильтра по типу. **UI карточка** [`WorkOrderDetailsPage.tsx`](../../electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx): даты редактируемы; Assembly «Закрыть и провести» намеренно скрыта (:2112) → двухшаговый флоу. Tiered-поиск переиспользуем: [`shared/src/domain/tieredSearch.ts`](../../shared/src/domain/tieredSearch.ts) (#035).

**Sync read-authz (security-ядро):** 3 pull-поверхности (`/ledger/state/changes`, `/snapshot`, `/query`) проходят через 2 слоя:
- [`pullReadFilter.ts:104`](../../backend-api/src/services/sync/pullReadFilter.ts) `makePullReadFilter` — TABLE (audit_log admin-only) + FIELD (PII/credentials EAV-редакция).
- [`syncPrivacy.ts:22`](../../backend-api/src/services/sync/syncPrivacy.ts) **`PRIVACY_TABLES`** (chat/notes/card_drafts) + `privacyFilterForTable` (SQL) + `makePrivacyRowFilter` (post) — **готовый row-level owner-visibility механизм** (та же линия, что фикс `password_hash` v2026.627.1151). **`operations` в нём НЕТ** → наряды видны всем с `OperationsEdit`.
- Actor `{id, login, role}` резолвится в [`auth/middleware.ts`](../../backend-api/src/auth/middleware.ts) (`requireAuth`); роль — `normalizeRole(login, systemRole)`.
- **Отчёты/зарплата:** [`reports.ts`](../../backend-api/src/routes/reports.ts) — actor резолвится (:714/:753), но per-row owner-гейт по нарядам **не применяется** (требует подтверждения в 3a).
- **Pre-sync DELETE/tombstone** для уже-утёкших строк — прецедент есть (#063 / password_hash cleanup), для operations **нет**.

## Решения (технические — приняты, фиксирую; владельцу — только приоритет/идентичность)

1. **Владелец наряда — в `row_owners`** (`tableName='operations'`, `rowId=op.id`, `ownerUserId`+`ownerUsername`), **без миграции** `operations`. Populate на push-применении создания наряда ([`applyPushBatch.ts:1058`](../../backend-api/src/services/sync/applyPushBatch.ts) — точка, где operations применяются на сервере). Бэкофилл существующих — из `audit_log` (action=create, table=operations) → `ownerUserId`.
2. **Гейт изоляции — расширение `syncPrivacy.ts`** (не новый механизм): наряд «ограничен» ⟺ его владелец ∈ restricted-set (старт: {Рамзия}); ограниченный наряд виден только {владелец (rw), Купцова (r), супер-админ (r)}. **Прочие наряды — без изменений** (нет регрессии видимости). Через `privacyFilterForTable` (SQL в pullChangesSince) + `makePrivacyRowFilter` (snapshot/query) — все 3 поверхности разом.
3. **Restricted-config — серверный, по login** (не хардкод UUID в коде): малый конфиг {restricted-владельцы → allowlist-читатели}, резолв login→userId на старте. Старт-данные: Рамзия (restricted), allowlist {Купцова, superadmin-роль}. Generalizable (#063 deepening), но минимально сейчас.
4. **Отчёты/зарплата — тот же гейт серверно:** ограниченные наряды исключаются из агрегатов non-allowlist actor'ов (хук в reports.ts, actor уже есть). Подтвердить точки агрегации в 3a.
5. **Pre-sync DELETE** ограниченных нарядов на клиентах вне allowlist — идемпотентный безусловный шаг (как password_hash cleanup #063), чистит уже-разъехавшееся.
6. **Баг `completedDate`:** UI [:1835](../../electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx) подставляет `Date.now()` в инпут → пусто, когда поле не задано; backend на close **не персистит** stale `completedDate` (нормализация). Поле — **стираемо** (не write-once).
7. **Кнопка «Наряд выполнен» на Assembly:** явная заметная кнопка-завершение, примиряющая двухшаговый draft-флоу (под капотом — `post-assembly`); рядом — поле реальной даты завершения. Нажатие «выполнен» = ставит `completedDate=now` + проводит **атомарно**; поле остаётся независимо редактируемым/стираемым.
8. **Атомарность проводки (#043):** обернуть create→plan→post в одну транзакцию (или компенсация — удалить orphaned-документ при сбое post); idempotency-guard сохранить.
9. **Фильтр типа в списке:** инлайн-селектор над текущим списком → `kind` в `workOrders.list()`; колонки/сорт/тогл уже есть. **Поиск:** подтвердить, что серверный `q` ищет по содержимому (детали/операции/исполнитель), не только №; при необходимости расширить + опц. tiered client-fallback.

## Фазы (каждая — отдельный PR, зелёные гейты + verify)

**Phase 0 — быстрый фикс даты завершения** (низкий риск, автономно, конкретная боль владельца). Решение 6. UI: убрать `?? Date.now()` + стираемость; backend close: не сохранять stale `completedDate`. Verify: открыть наряд на сборку, поле пустое пока не задано, заносится и стирается.

**Phase 1 — карточка: кнопка «выполнен» + атомарность + семантика 4 дат** (решения 6–8). Кнопка «Наряд выполнен» для Assembly рядом с датой завершения; атомарная идемпотентная проводка; все даты пустые кроме создания. Verify на реальном наряде сборки — **особенно атомарность** (двойное нажатие не списывает дважды; сбой post не плодит orphaned-док).

**Phase 2 — список: фильтр типа + поиск-по-внутренностям** (решение 9, координация с card-письмом — одна доработка). Инлайн-селектор типа; подтвердить/расширить контент-поиск. Колонки/сорт/тогл — уже есть.

**Phase 3 — РОЛЕВАЯ ИЗОЛЯЦИЯ Рамзии** (security-ядро, отдельная под-нитка; решения 1–5):
- **3a. Recon-confirm** (brain: recon ДО дизайна): подтвердить точки агрегации reports/payroll; есть ли уже owner на operations-push; «какие коды реально энфорсятся vs UI-only»; deny-log хук.
- **3b. Owner-tracking:** `row_owners` populate на create + бэкофилл из audit_log; ground-truth логины Рамзии/Купцовой.
- **3c. Серверный гейт:** `syncPrivacy` для operations(work_order) по owner+allowlist — все 3 pull-поверхности.
- **3d. Отчёты/зарплата:** тот же гейт серверно.
- **3e. Pre-sync DELETE** уже-утёкших ограниченных нарядов на клиентах вне allowlist.
- **3f. UI-фильтр** поверх (удобство, **не** граница доверия).
- **3g. Adversarial-review диффа** (#058: over-restriction скрыл чужое / under-restriction утечка) + **live-verify под ролью Рамзии и под ролью «остальной»** + deny-log.

## Открытые вопросы владельцу (минимум)

1. **Приоритет/последовательность:** сначала отгрузить быстрые Phase 0–2 (конкретная боль, низкий риск), затем изоляцию Phase 3 отдельной security-под-ниткой? Или изоляция важнее и идём с неё?
2. **Идентичность:** подтвердить реальные логины Рамзии и Купцовой (резолвлю из БД, владелец подтверждает) + что allowlist именно {Рамзия rw, Купцова r, супер-админ r}.
3. **Обобщение:** хард-скоуп на Рамзию сейчас vs общий механизм «приватные наряды на оператора» (рекомендую минимально-сейчас/обобщить-позже — решение 3).

## Гейты / verify

Каждая фаза: `shared`+`ledger` build → `corepack pnpm -r typecheck` + lint → `backend-api test` → **CDP e2e-smoke** (verifier-electron) при UI-правках. Phase 1 — verify атомарности проводки. Phase 3 — обязательный dual-role live-verify + adversarial-review диффа фильтра (security). Ответ brain через `mailbox/to-brain/` при появлении переносимого паттерна (row-level visibility на sync-границе → углубление #063, рефлекс #009).
