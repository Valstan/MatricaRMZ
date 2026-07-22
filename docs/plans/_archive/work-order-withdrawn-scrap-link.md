# Утильная деталь двигателя ⇄ наряд на сборку: авто-отзыв, причина, блокировка выдачи, статус «Отозван»

## Context

Реальный случай на заводе: выписан наряд на сборку, во время сборки картер верхний признан утильным (в дефектовке `scrap_qty > 0`, строка красная). Оператор вручную нажал «Отозвать из работы» — но:
- причина отзыва нигде не фиксируется;
- отзыв не автоматизирован (утиль в дефектовке ≠ реакция наряда);
- можно выдать наряд в работу при живом утиле;
- отозванный наряд показывается со статусом «Просрочен» (некорректно).

Решения владельца (подтверждены): авто-возврат в работу НЕ делать — только разблокировать кнопку; название статуса — **«Отозван»**; в печатную форму статус НЕ добавлять.

## Ключевые факты кода (из разведки)

- Наряд = строка `operations` (`operation_type='work_order'`), payload в `meta_json`. «Выдан/отозван» = boolean `repairIssued` в payload ([workOrder.ts:342](shared/src/domain/workOrder.ts)).
- Статусы **вычисляемые**: `WorkOrderStatusCode = 'issued'|'done'|'overdue'|'done_late'`, `deriveWorkOrderStatusCode` (workOrder.ts:509-538), labels :496-501.
- ⚠️ **`normalizeWorkOrderPayloadV3Fields` (workOrder.ts:422-484) строит payload по явному списку полей** — любое новое поле обязано быть добавлено туда, иначе молча теряется при save (аналог gotcha «zod strip»).
- Утиль = `scrap_qty > 0` в `EngineInventoryRow` дефектовки ([repairChecklist.ts:323](shared/src/domain/repairChecklist.ts)).
- Чеклист сохраняется в ДВУХ местах: клиент `electron-app/src/main/services/checklistService.ts::saveRepairChecklistForEngine` (:240) и backend `backend-api/src/services/checklistService.ts` (:92-98 нормализация scrap).
- Связь наряд→двигатель: `operations.engine_entity_id` (schema.ts:96) + payload `assemblyEngineId`, резолвер `resolveAssemblyEngineId` (workOrder.ts:646).
- Кнопка выдать/отозвать: `WorkOrderDetailsPage.tsx:2696-2720`, обработчик `toggleRepairIssued()` :1048-1070. AuditTrail `{at,by,action,note?}` уже есть (workOrder.ts:37-42), note не заполняется.

## План

### 1. shared/src/domain/workOrder.ts — модель

Новые опциональные поля payload:
```ts
withdrawnAt?: number;      // ms; наличие = наряд отозван после выдачи
withdrawnReason?: string;  // причина (оператор или авто-текст)
withdrawnAuto?: boolean;   // true = авто-отзыв по утилю
```
- «Отозван» = `withdrawnAt > 0` && `repairIssued !== true` && операция не закрыта. Черновик, который не выдавался, `withdrawnAt` не имеет → как раньше. При повторной выдаче поля `withdrawn*` очищаются.
- **Добавить поля в `normalizeWorkOrderPayloadV3Fields`** (критично).
- `WorkOrderStatusCode` + `'withdrawn'`; label «Отозван». В `deriveWorkOrderStatusCode` — параметр `withdrawnAt`, ветка после `closed`, но ДО overdue (отозванный не «просрочивается»).
- Хелперы `applyWorkOrderWithdrawal(payload, {at, by, reason, auto})` / `applyWorkOrderIssue(payload, {at, by})` — единая логика для клиента и backend; пишут auditTrail item `{action:'withdraw'|'issue', note}`. Условный spread (exactOptionalPropertyTypes).

### 2. shared/src/domain/repairChecklist.ts — детектор утиля

- `listScrapPartNames(payload): string[]` — имена строк с `scrap_qty > 0` (engine_inventory + legacy defect).
- `buildAutoWithdrawReason(partNames)` → «Деталь признана утильной: Картер верхний».

### 3. Авто-отзыв при сохранении дефектовки (2 хука, общая shared-логика)

1. **Клиент** `electron-app/src/main/services/checklistService.ts::saveRepairChecklistForEngine`: после записи — если есть scrap-строки, найти локальные open `work_order`-операции этого двигателя (Assembly, `repairIssued===true`, через `resolveAssemblyEngineId`), применить `applyWorkOrderWithdrawal(auto:true)`, `syncStatus='pending'`. try/catch — ошибка хука не роняет сохранение чеклиста.
2. **Backend** `backend-api/src/services/checklistService.ts`: аналогично после нормализации scrap; поиск по `engine_entity_id` + fallback по payload (у старых нарядов колонка может быть пустой); `recordSyncChanges`, чтобы изменение уехало клиентам. Покрывает случай «дефектовка на клиенте A, наряд на клиенте B».

Хук идемпотентен (пропускает `repairIssued !== true`) — повторное сохранение дефектовки чинит проигранный LWW-конфликт.

### 4. UI: модалка причины + блокировка выдачи (WorkOrderDetailsPage.tsx)

- Разделить `toggleRepairIssued` → `issueToWork()` / `withdrawFromWork(reason)`.
- «Отозвать из работы» → модалка с textarea «Причина отзыва», подтверждение disabled при пустом trim.
- Для Assembly-наряда с двигателем: загрузить дефектовку существующим IPC (`checklists.get`), посчитать `scrapParts`; при `scrapParts.length > 0` — «Выдать в работу» disabled + текст «Выдача заблокирована: утильные детали — …». Утиль снят → кнопка снова активна (выдаёт человек, авто-выдачи нет).
- В блоке статуса карточки (:2149-2164) при `withdrawn` показать «Отозван <дата>: <причина>».

### 5. Статус «Отозван» в отображениях

- `WorkOrdersPage.tsx:60-90` — палитра (нейтральный серый бейдж), derive с `withdrawnAt`, сортировка (`withdrawn` между overdue и done), короткая метка «Отозван».
- `shared/src/domain/workOrdersReport.ts` (:16, :50, :67-70, :132, :177-179, :206) — код/label/цвет/сортировка в отчёте «Наряды».
- Печатная форма — **не трогаем** (решение владельца).
- Grep по `WORK_ORDER_STATUS_LABELS` на прочие потребители.

### 6. Совместимость / риски

- Старые payload без полей → поведение как раньше; ранее отозванные наряды останутся без причины (норм).
- Старые клиенты срежут `withdrawn*` при сохранении наряда (их normalize) — данные некритичные, авто-отзыв повторится; отметить в release notes.
- Главный риск — забыть normalize (п.1); проверить round-trip'ом.

## Верификация

1. `corepack pnpm -F @matricarmz/shared build` → `typecheck`+`lint` по пакетам (последовательно — gotcha dist-race).
2. `corepack pnpm -F @matricarmz/backend-api test`.
3. verifier-electron e2e (PG 5433, профиль PC40): TEST-001 → выданный Assembly-наряд → в дефектовке scrap_qty=1 у детали → наряд стал «Отозван» с авто-причиной, красная строка; кнопка «Выдать» disabled с пояснением → scrap_qty=0 → кнопка активна → выдать вручную → статус «Выдан», withdrawn* очищены.
4. Проверить отчёт «Наряды»: статус «Отозван» в колонке и сортировке.

## Файлы

- `shared/src/domain/workOrder.ts`, `shared/src/domain/repairChecklist.ts`, `shared/src/domain/workOrdersReport.ts`
- `electron-app/src/main/services/checklistService.ts`, `electron-app/src/main/services/workOrderService.ts`
- `electron-app/src/renderer/src/ui/pages/WorkOrderDetailsPage.tsx`, `WorkOrdersPage.tsx`
- `backend-api/src/services/checklistService.ts`

PR-flow: ветка `feat/work-order-withdrawn-scrap-link`, PR, гейты зелёные → merge. После одобрения плана скопировать этот план в `docs/plans/work-order-withdrawn-scrap-link.md`.
