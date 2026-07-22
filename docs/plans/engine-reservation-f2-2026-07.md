# Ф2 — Advisory-резервирование двигателя (план реализации)

**Status:** ACTIVE (код смержен; открыта приёмка на живом стенде)
**Created:** 2026-07-22
**Родитель:** [tablet-shop-floor.md](tablet-shop-floor.md) §Ф2
**Происхождение:** синтез 3 независимых вариантов проектирования + 3 судейских вердикта (разведка по 6 подсистемам).

## Решение

Берём за основу Вариант 1 (2 из 3 судей): хранение — ОДИН json-EAV-атрибут `engine_reservation` на engine-entity (ноль точек sync-контракта, ноль DDL, ноль `db:migrate` на проде, ноль новых значений `sync_status`), гейт — мягкий, в `partitionLedgerInputsByAuthz` ДО ledger-append (проверено: `signAndAppendDetailed` идёт раньше `applyPushBatch`, а у гейта ровно один call-site — `ledgerTxService.ts:53`, значит replay и maintenance-скрипты обходят его бесплатно). Прививаем из Варианта 3 главное, что судьи 1 и 3 назвали лучшим: резерв становится СЕРВЕРНО-АВТОРИТЕТНЫМ — take/renew/release идут маленьким REST-эндпойнтом с серверными часами и CAS поверх существующего уникального индекса `attribute_values_entity_attr_uq`, а клиент замок только ЧИТАЕТ; это разом убирает скос часов планшета, гонку одновременного взятия, попутный churn `entities` через `setEngineAttribute` и необходимость резолвить ФИО на клиенте (сервер штампует `holderFullName` в json через `resolveLoginsToFullNames`). Второй обязательный трансплантат из V3 — правило pre-lock grace: строки с `updated_at <= startedAt + 15 мин` НЕ режутся, поэтому планшет, неделю проработавший оффлайн, не теряет работу задним числом и объём отбитых строк схлопывается до единиц (это и снимает главную претензию судей к V1 про push-петлю). Из V3 берём также клиентский backstop `forbidden:server_managed_attr:engine_reservation` для ЛЮБОЙ роли — подделать/стереть замок оффлайн-клиент структурно не может, и «гейт не блокирует сам себя» получается бесплатно, без спец-кейса в advisory-ветке. Критическую находку судьи 3 поднимаем в само правило гейта: операции гейтятся не по факту наличия `engine_entity_id`, а по БЕЛОМУ СПИСКУ типов операций карточки двигателя — иначе замок двигателиста молча резал бы наряды мастера, заявки снабжения и складские движения кладовщика. Сознательно НЕ берём из V2/V3 дорогую машинерию: ни отдельной синкаемой таблицы (21 точка плумбинга, две рукописные миграции, дубль в `ensureClientSchemaParity`), ни sweeper'а (истечение считается предикатом на чтении), ни четвёртого значения `sync_status` ('deferred'/'rejected') — все три судьи назвали его ловушкой с режимом отказа «строки не уедут никогда». Из V1 сохраняем его уникальную находку — фильтрацию `reserved:*` из `recordLedgerAuthzDenial`, иначе занятый двигатель заливал бы владельцу встроенный раздел «Критические события» warn-событиями категории auth. Оператору даём аварийный выход «Всё равно редактировать» с честным предупреждением, оффлайн-очередь на СНЯТИЕ резерва (жест «закончил → вернул» происходит у станка, а не у Wi-Fi) и бейдж «занят» в списке двигателей — стартовом экране планшетного режима.

## TTL и константы

12 часов (`ENGINE_RESERVATION_TTL_MS = 12*60*60*1000`), продление — событийное, при сохранении карточки, серверный троттлинг «не чаще TTL/2» (≤2 ledger-записи на двигатель в сутки; периодический heartbeat-renew ЗАПРЕЩЁН — это прод-инцидент M28). Истечение вычисляется предикатом на чтении (`isEngineReservationLive`), фонового sweeper'а нет. Дополнительно `ENGINE_RESERVATION_RECENTLY_EXPIRED_MS = 2 ч` — только текст плашки «резерв Иванова истёк 40 мин назад», НЕ блокировка. `ENGINE_RESERVATION_PRE_LOCK_GRACE_MS = 15 мин` — допуск на скос часов при сравнении `row.updated_at` со `startedAt`. Все четыре числа — константы в одном shared-модуле, меняются одной правкой после обкатки.

## Шаги

### Шаг 1 — Доменный модуль shared/src/domain/engineReservation.ts — единственный источник правил для сервера и клиента

**Файлы:** `shared/src/domain/engineReservation.ts`, `shared/src/index.ts`, `shared/src/domain/engineReservation.test.ts`

Новый leaf-модуль по образцу shared/src/domain/engineInternalNumber.ts (чистые функции, ноль I/O, ноль импортов из backend/electron). Экспорты РОВНО такие:

Константы:
- `export const ENGINE_RESERVATION_CODE = 'engine_reservation'` (префикс `engine_` обязателен — правило CLAUDE.md, голый код занят другими типами);
- `ENGINE_RESERVATION_TTL_MS = 12*60*60*1000`;
- `ENGINE_RESERVATION_RENEW_AFTER_MS = ENGINE_RESERVATION_TTL_MS/2`;
- `ENGINE_RESERVATION_PRE_LOCK_GRACE_MS = 15*60*1000`;
- `ENGINE_RESERVATION_RECENTLY_EXPIRED_MS = 2*60*60*1000`.

Тип:
`export type EngineReservation = { v: 1; holderUserId: string; holderLogin: string; holderFullName: string; startedAt: number; expiresAt: number; releasedAt: number | null; releasedBy: 'holder' | 'admin' | null }`.

Функции:
- `parseEngineReservation(raw: unknown): EngineReservation | null` — принимает и объект (клиент: `attributes[code]` уже прогнан через safeJsonParse в getEngineDetails), и строку (сервер: `value_json` — text); отбрасывает `null`, мусор, `v !== 1`, нечисловые времена, пустой `holderUserId`;
- `isEngineReservationLive(r: EngineReservation | null, nowMs: number): boolean` = `!!r && r.releasedAt == null && r.expiresAt > nowMs`;
- `engineReservationState(r, { nowMs, viewerUserId }): 'free' | 'mine' | 'other' | 'expired_recently'` — 'expired_recently' когда `!live && releasedAt == null && nowMs - expiresAt <= ENGINE_RESERVATION_RECENTLY_EXPIRED_MS` (только для текста);
- `shouldRenewEngineReservation(r, { nowMs, viewerUserId }): boolean` = live && мой && `nowMs - r.startedAt > ENGINE_RESERVATION_RENEW_AFTER_MS`;
- `isEngineEditBlockedByReservation(args: { reservation: EngineReservation | null; actorUserId: string; rowUpdatedAt: number; nowMs: number; actorIsAdmin: boolean }): boolean` — ЕДИНСТВЕННОЕ правило гейта. Блокируем ⟺ `isEngineReservationLive` И `actorUserId` непустой И `reservation.holderUserId !== actorUserId` И `!actorIsAdmin` И `rowUpdatedAt > reservation.startedAt + ENGINE_RESERVATION_PRE_LOCK_GRACE_MS`. Последнее условие — сердце оффлайн-дизайна: правки, сделанные ДО взятия замка, проходят и разруливаются LWW;
- `ENGINE_RESERVATION_GATED_OPERATION_TYPES: ReadonlySet<string>` = `new Set(['defect','defect_act','engine_inventory','kitting','completeness','completeness_act','claim_act','disassembly','part_status_event','repair_fund_instance','repair_fund_requirement'])` и `isEngineReservationGatedOperationType(t: string): boolean`. WHY-комментарий обязателен: `engine_entity_id` есть у ВСЕХ операций (work_order, supply_request, stock_receipt/issue/transfer, otk, test, packaging, shipment, customer_delivery, tool_movement, workshop_transfer) — их пишут мастер/снабженец/кладовщик, у которых нет ни плашки, ни кнопки резерва; гейтим только то, что двигателист правит из карточки;
- `engineReservationSkipReason(r: EngineReservation): string` → `` `reserved:${r.holderLogin}:${r.expiresAt}` `` и `parseEngineReservationSkipReason(reason: string): { holderLogin: string; expiresAt: number } | null` (парсить с конца по последнему ':', чтобы логин с двоеточием не ломал round-trip). Контекст едет внутри свободной строки `reason`, потому что `syncSkippedRowSchema` (shared/src/sync/dto.ts:187) требует `row_id: uuid` и свободных полей не имеет;
- `formatEngineReservationHolder(r): string` — обёртка над `formatClientLabel({ login: r.holderLogin, fullName: r.holderFullName })` из shared/src/domain/clientLabel.ts (правило проекта «логин + ФИО»);
- `formatEngineReservationUntil(expiresAt: number): string` → «до 22.07 20:30».

В shared/src/index.ts добавить `export * from './domain/engineReservation.js';` рядом со строкой 13 (где `engineInternalNumber`).

**Приёмка:** `corepack pnpm -F @matricarmz/shared build` зелёный; `engineReservation.test.ts` покрывает: live на границе `expiresAt === now`; state free/mine/other/expired_recently; блокировка чужого + пропуск строки с `rowUpdatedAt < startedAt`; пропуск при пустом `actorUserId`; пропуск при `actorIsAdmin`; пропуск истёкшего; round-trip skipReason с логином, содержащим ':'; `parseEngineReservation` одинаково ест объект и JSON-строку.

### Шаг 2 — Регистрация attribute_def engine_reservation: seed клиента + dev-бутстрап + серверный фолбэк

**Файлы:** `electron-app/src/main/database/seed.ts`, `backend-api/src/scripts/bootstrapDevEntityTypes.ts`

seed.ts: сразу после строки 140 (`ensureAttrDef(engineTypeId, ENGINE_INTERNAL_NUMBER_YEAR_CODE, ...)`) добавить
`await ensureAttrDef(engineTypeId, ENGINE_RESERVATION_CODE, 'Резерв двигателя', AttributeDataType.Json, 95);`
и импорт `ENGINE_RESERVATION_CODE` в блок импортов из '@matricarmz/shared' (строки 5-12).
ИМЕННО в seed, а НЕ в `desired`-списке `ensureAttributeDefs` карточки (EngineDetailsPage.tsx:1102-1154): тот эффект гейтится `props.canEditMasterData` (строка 1101), которого у роли `engineer` нет, плюс `listEngines` читает def напрямую (ровно причина, записанная комментарием seed.ts:137-138). В `desired` карточки НЕ добавлять — поле руками не редактируется, `persistFieldOrder` только зря шевелил бы sortOrder.

bootstrapDevEntityTypes.ts: после строки 58 (где заводится `ENGINE_INTERNAL_NUMBER_YEAR_CODE`) добавить `await ensureAttr(engineId, ENGINE_RESERVATION_CODE, 'Engine reservation', AttributeDataType.Json, 95);` — иначе на стенде `verifier-electron` серверный сервис не найдёт def и e2e-смоук будет зелёным по ложной причине.

Серверный фолбэк на пустой БД реализуется в шаге 3 (`ensureEngineReservationDef`), сюда его не тащить.

**Приёмка:** Свежая клиентская БД: после seed в `attribute_defs` есть строка (engine type, 'engine_reservation', json) c `sync_status='pending'`; после первого синка она есть и на сервере. `pnpm -F @matricarmz/backend-api exec tsx src/scripts/bootstrapDevEntityTypes.ts` не падает и создаёт def.

### Шаг 3 — Сервер: engineReservationService — серверные часы, атомарный CAS, запись через sync-путь, batched-чтение для гейта

**Файлы:** `backend-api/src/services/engineReservationService.ts`

Новый leaf-модуль (образец стиля — engineNumberGuard.ts / restrictedWorkOrders.ts: простые select без innerJoin). Резерв пишет ТОЛЬКО сервер: в проекте нет ни одной компенсации скоса часов, а взятие резерва и так «только при наличии сети» (требование владельца) — значит серверные часы бесплатны.

Внутренние хелперы:
- `ensureEngineReservationDef(actor): Promise<string>` — найти def по (engine entity type, ENGINE_RESERVATION_CODE); при отсутствии создать через уже экспортированный `upsertAttributeDef(actor, { entityTypeId, code: ENGINE_RESERVATION_CODE, name: 'Резерв двигателя', dataType: AttributeDataType.Json, sortOrder: 95 })` (adminMasterdataService.ts:619 — он резурректит существующую строку по паре (type, code), идемпотентен). Результат кешировать в модульной переменной.
- `readReservationRow(engineId, defId)` → `{ id, valueJson, createdAt, updatedAt } | null` — один select по (entityId, attributeDefId).
- `writeReservationValue({ rowId, engineId, defId, existing, value, actor })` — CAS:
  * `const ts = existing ? Math.max(Date.now(), Number(existing.updatedAt) + 1) : Date.now();` (монотонность обязательна — иначе pair-LWW отбросит собственную запись, прецедент adminMasterdataService.ts:1043);
  * есть строка → `db.update(attributeValues).set({ valueJson, updatedAt: ts, syncStatus: 'synced' }).where(and(eq(attributeValues.id, existing.id), eq(attributeValues.updatedAt, existing.updatedAt))).returning({ id })`; пусто → `{ raced: true }`;
  * нет строки → `db.insert(attributeValues).values({ id: randomUUID(), entityId, attributeDefId: defId, valueJson, createdAt: ts, updatedAt: ts, deletedAt: null, syncStatus: 'synced' }).onConflictDoNothing({ target: [attributeValues.entityId, attributeValues.attributeDefId] }).returning({ id })` (уникальный индекс `attribute_values_entity_attr_uq` существует, schema.ts:90); пусто → `{ raced: true }`;
  * затем `await recordSyncChanges({ id: actor.id, username: actor.username, role: actor.role }, [{ tableName: SyncTableName.AttributeValues, rowId, op: 'upsert', payload: { id, entity_id, attribute_def_id, value_json, created_at, updated_at: ts, deleted_at: null, sync_status: 'synced' } }])`.
  * ИНВАРИАНТ (WHY-комментарий обязателен): `payload.updated_at` ДОЛЖЕН быть равен `ts`, записанному в строку. `filterStaleBySeqOrUpdatedAt` в applyPushBatch заканчивается `return !(cur.updatedAt > r.updated_at)` — при меньшем значении строка будет отфильтрована, `last_server_seq` не обновится и соседи НИКОГДА не увидят замок инкрементальным pull'ом (класс M6/M8).
  * Актор — ВСЕГДА реальный employee-uuid из сессии, никогда `{ id: 'system' }`.
  * `raced` → перечитать и повторить РОВНО один раз, затем вернуть 409-результат.
  * НЕ переиспользовать `setEntityAttribute` из adminMasterdataService: он гоняет `findDuplicateEntityId` (тяжёлый join c limit 50_000) и может отказать сообщением «Дубликат: уже существует объект» на двигателях с совпадающими номерами.

Экспорты:
- `getEngineReservation(engineId): Promise<{ reservation: EngineReservation | null; serverNow: number }>`;
- `acquireEngineReservation({ engineId, actor }): Promise<{ ok: true; reservation; row } | { ok: false; status: 409 | 404; error: string; holder?: EngineReservation }>` — читает текущее; если live и чужой → 409 + holder; если live и мой → продление ТОЛЬКО когда `shouldRenewEngineReservation` (иначе возвращает текущее состояние БЕЗ записи — серверный троттлинг, ≤2 ledger-записи в сутки); иначе собирает `{ v:1, holderUserId: actor.id, holderLogin: actor.username, holderFullName: (await resolveLoginsToFullNames([actor.username]))[actor.username.toLowerCase()] ?? '', startedAt: now, expiresAt: now + ENGINE_RESERVATION_TTL_MS, releasedAt: null, releasedBy: null }` и пишет CAS'ом;
- `releaseEngineReservation({ engineId, actor, byAdmin }): Promise<{ ok: true; reservation } | { ok: false; status; error }>` — держатель всегда; чужой только при `byAdmin`; пишет ЗНАЧЕНИЕ (`releasedAt: now`, `releasedBy: 'holder'|'admin'`), НИКОГДА не soft-delete строки (getEngineDetails на клиенте, engineService.ts:501-506, читает без `isNull(deletedAt)` — soft-deleted резерв продолжал бы «висеть» в карточке);
- `getLiveEngineReservations(engineIds: string[]): Promise<Map<string, EngineReservation>>` — для гейта: два ПРОСТЫХ select без innerJoin (defIds по коду; затем attributeValues по `inArray(entityId)` + `inArray(attributeDefId)` + `isNull(deletedAt)`), код атрибута дофильтровать ещё и в JS (мок `makeTxSelectFromTableMap` игнорирует `.where`); в Map кладутся только live-резервы; модульный кеш TTL 10 с, инвалидируемый на acquire/release в этом же процессе (второй backend-процесс может отставать до 10 с — для advisory приемлемо, зафиксировать комментарием).

**Приёмка:** Юнит-тесты (мок db в стиле dbMockHelpers): acquire на свободном → ok, `holderUserId === actor.id`, `expiresAt === serverNow + TTL`; второй acquire чужим при live → status 409 + holder; acquire держателем раньше RENEW_AFTER → `recordSyncChanges` НЕ вызывался; позже RENEW_AFTER → вызван, `expiresAt` продлён, `updated_at` строго монотонен; release не-держателем без byAdmin → 403; release админом → `releasedBy: 'admin'`, `deleted_at` остался null; подмена `updatedAt` между чтением и UPDATE → ровно одна перепопытка, затем 409.

### Шаг 4 — Сервер: три REST-эндпойнта резерва в routes/engines.ts

**Файлы:** `backend-api/src/routes/engines.ts`

По образцу уже имеющихся роутов файла (строки 11-30): `requireAuth` + `requirePermission(PermissionCode.EnginesView/EnginesEdit)`, актор из `(req as unknown as { user?: { id?: string; username?: string; role?: string } }).user`.

- `GET /engines/:id/reservation` — `requirePermission(PermissionCode.EnginesView)` → `{ ok: true, reservation, serverNow }`.
- `POST /engines/:id/reservation` — `requirePermission(PermissionCode.EnginesEdit)`; тело пустое; вызывает `acquireEngineReservation`; при `ok:false` отдаёт `res.status(result.status).json(result)` (409 несёт `holder`, чтобы клиент сразу показал «Уже взял <логин+ФИО> до <время>»); при успехе отдаёт `{ ok: true, reservation, row }`, где `row` — записанная строка attribute_values в snake_case DTO-форме (id, entity_id, attribute_def_id, value_json, created_at, updated_at, deleted_at, sync_status), чтобы клиент применил её локально мгновенно.
- `DELETE /engines/:id/reservation` — `requirePermission(PermissionCode.EnginesEdit)`; `byAdmin = ['admin','superadmin'].includes(String(user?.role ?? '').toLowerCase())`; вызывает `releaseEngineReservation`; ответ той же формы.

Новый `PermissionCode` НЕ вводить: админ-снятие гейтится прямой проверкой роли — устоявшийся прецедент (App.tsx:4920, AdminPage.tsx:232, комментарий auth/permissions.ts:91-92); неподключённые permissions вида `defect_act.*` показывают, чем это кончается.
Правок nginx не требуется — конфиг catch-all (deploy/nginx/, memory pending_followups).

**Приёмка:** На дев-стенде: `curl -X POST .../engines/<id>/reservation` под пользователем A → 200 + reservation; тот же вызов под B → 409 с holder=A; `DELETE` под B (роль engineer) → 403; `DELETE` под admin → 200, `releasedBy: 'admin'`; `GET` под ролью без engines.view → 403.

### Шаг 5 — Сервер: backstop server-managed атрибута + мягкий advisory-гейт в ledgerAuthzGuard + фильтр reserved из deny-лога

**Файлы:** `backend-api/src/services/sync/ledgerAuthzGuard.ts`, `backend-api/src/services/sync/ledgerTxService.ts`

ОТКЛОНЕНИЕ ОТ БУКВЫ ПЛАНА (docs/plans/tablet-shop-floor.md:74 называет applyPushBatch) — обосновать в теле PR: `signAndAppendDetailed` (syncWriteService.ts:225) выполняется РАНЬШЕ `applyPushBatch` (:262), поэтому скипнутая там строка остаётся в неизменяемом ledger и `replayLedgerToDb` (allowSyncConflicts:true) её воскресит. `partitionLedgerInputsByAuthz` работает ДО ledger-append, уже отдаёт `SyncSkippedRow[]`, уже резолвит `entity_type_id`/`code` батчами и имеет РОВНО один call-site (ledgerTxService.ts:53) → replay, `changes.ts`, maintenance-скрипты и `recordSyncChanges` из шага 3 идут мимо гейта без единого bypass-флага.

A) Backstop (для ЛЮБОЙ роли, включая superadmin) — внутрь существующего блока `if (inp.table === SyncTableName.AttributeValues)` (строки 148-158), сразу после `isServerOnlyEmployeeAttr`:
```
if (attrCode === ENGINE_RESERVATION_CODE && entityTypeCode === EntityTypeCode.Engine) {
  denied.push({ table: inp.table, row_id: inp.row_id, reason: `forbidden:server_managed_attr:${ENGINE_RESERVATION_CODE}` });
  continue;
}
```
Это делает невозможным подделку/стирание замка клиентом и структурно снимает проблему «гейт блокирует собственное Вернуть» (releases идут эндпойнтом, а не push'ом). Эти денаи в deny-лог ПОПАДАЮТ — это настоящая аномалия.

B) Кандидаты (ДО основного цикла, после блока `codeByDefId`, ~строка 105):
```
const RESERVATION_GATE_ENABLED = String(process.env.MATRICA_ENGINE_RESERVATION_GATE ?? 'on').toLowerCase() !== 'off';
const actorIsAdmin = role === 'admin' || role === 'superadmin';
const nowMs = Date.now();
const reservationCandidates = new Set<string>();
if (RESERVATION_GATE_ENABLED && !actorIsAdmin && str(actor.id)) {
  for (const inp of inputs) {
    if (inp.table === SyncTableName.AttributeValues) {
      const eid = str(inp.row?.['entity_id']);
      const tid = typeIdByEntityId.get(eid);
      if (eid && tid && codeByTypeId.get(tid) === EntityTypeCode.Engine) reservationCandidates.add(eid);
    } else if (inp.table === SyncTableName.Entities) {
      if (codeByTypeId.get(str(inp.row?.['entity_type_id'])) === EntityTypeCode.Engine) reservationCandidates.add(str(inp.row?.['id'] ?? inp.row_id));
    } else if (inp.table === SyncTableName.Operations && isEngineReservationGatedOperationType(str(inp.row?.['operation_type']))) {
      const eid = str(inp.row?.['engine_entity_id']);
      if (eid) reservationCandidates.add(eid);
    }
  }
}
const reservationByEngineId = reservationCandidates.size > 0 ? await getLiveEngineReservations([...reservationCandidates]) : new Map<string, EngineReservation>();
```

C) Advisory-ветка в основном цикле — ПОСЛЕ блока section-viewer и НЕПОСРЕДСТВЕННО ПЕРЕД `if (!operatorScoped)` (строка ~195), чтобы гейт бил все роли кроме admin/superadmin, а не только operator-scoped:
```
if (reservationByEngineId.size > 0) {
  let engineId: string | null = null;
  if (inp.table === SyncTableName.AttributeValues && entityTypeCode === EntityTypeCode.Engine) engineId = ownerEntityId;
  else if (inp.table === SyncTableName.Entities && entityTypeCode === EntityTypeCode.Engine) engineId = ownerEntityId;
  else if (inp.table === SyncTableName.Operations && isEngineReservationGatedOperationType(operationType ?? '')) engineId = str(inp.row?.['engine_entity_id']);
  const res = engineId ? reservationByEngineId.get(engineId) : undefined;
  if (res && isEngineEditBlockedByReservation({ reservation: res, actorUserId: str(actor.id), rowUpdatedAt: Number(inp.row?.['updated_at'] ?? 0), nowMs, actorIsAdmin })) {
    denied.push({ table: inp.table, row_id: inp.row_id, reason: engineReservationSkipReason(res) });
    continue;
  }
}
```
В шапку модуля дописать абзац: гейт advisory; покрывает engine-entity, её attribute_values и операции из белого списка типов; смежные сущности (детали ремфонда как самостоятельные записи, номенклатура, файлы) НЕ покрыты — осознанное ограничение, не баг. Kill-switch `MATRICA_ENGINE_RESERVATION_GATE=off` гасит ТОЛЬКО advisory-ветку (B/C), backstop (A) действует всегда.

D) ledgerTxService.ts:54 — заменить `if (denied.length > 0) recordLedgerAuthzDenial(writeActor, denied);` на
```
const loggableDenied = denied.filter((d) => !d.reason.startsWith('reserved:'));
if (loggableDenied.length > 0) recordLedgerAuthzDenial(writeActor, loggableDenied);
```
WHY-комментарий: `reserved` — нормальная операционная ситуация, а `recordLedgerAuthzDenial` заводит warn-события `server.authz.denied` категории auth во встроенный раздел «Критические события» — единственный канал уведомлений владельца (`skipped` при этом продолжает уезжать клиенту полностью).

**Приёмка:** Дописанные кейсы в существующем backend-api/src/services/sync/ledgerAuthzGuard.test.ts (248 строк, готовый table-aware мок) зелёные: чужая правка attribute_values reserved-двигателя → denied `reserved:<login>:<ts>`; правка держателя → allowed; строка с `updated_at < startedAt` → allowed; истёкший резерв → allowed; actor-admin → allowed; `actor.id` пустой/не-uuid → allowed; клиентская запись `engine_reservation` → denied `forbidden:server_managed_attr:engine_reservation` для ЛЮБОЙ роли, включая superadmin; операция `defect_act` по reserved-двигателю → denied; операции `work_order` / `supply_request` / `stock_issue` / `otk` по тому же двигателю → allowed; `MATRICA_ENGINE_RESERVATION_GATE=off` → всё allowed, кроме backstop. Существующие sync.test.ts и presenceNotLedgered.test.ts остаются зелёными БЕЗ правок.

### Шаг 6 — Клиент main: HTTP-клиент резерва, оффлайн-очередь на снятие, IPC/preload/контракт, запрет локальной записи атрибута

**Файлы:** `electron-app/src/main/services/engineReservationClient.ts`, `electron-app/src/main/services/engineService.ts`, `electron-app/src/main/services/settingsStore.ts`, `electron-app/src/main/services/syncManager.ts`, `electron-app/src/main/ipc/register/enginesOpsAudit.ts`, `electron-app/src/preload/index.ts`, `shared/src/ipc/types.ts`

engineReservationClient.ts (новый, образец — changesService.ts / erpService.engineDedupeMerge: сетевые сервисы берут sysDb для токенов, `httpAuthed(db, apiBaseUrl, path, init, opts)`):
- `getEngineReservation(sysDb, apiBaseUrl, engineId)` → `{ ok, reservation, serverNow }`;
- `acquireEngineReservation(sysDb, dataDb, apiBaseUrl, engineId)` — POST с `{ attempts: 1 }` (не идемпотентно повторять); при 409 вернуть `{ ok:false, error: 'Двигатель уже взял <formatEngineReservationHolder(holder)> — <formatEngineReservationUntil>' }`; при успехе применить `row` в локальную `attribute_values` (upsert по `row.id`: insert ... onConflictDoUpdate по id, поля из DTO, `syncStatus: 'synced'`) — плашка появляется мгновенно, а `sync_status='synced'` гарантирует, что строка НЕ уедет в push (её отбил бы backstop);
- `releaseEngineReservation(sysDb, dataDb, apiBaseUrl, engineId, { byAdmin })` — то же; при сетевой ошибке НЕ падать, а поставить намерение в очередь (см. ниже) и вернуть `{ ok: true, queued: true }`;
- `flushPendingEngineReservationReleases(sysDb, dataDb, apiBaseUrl)` — прочитать очередь, по каждому engineId дёрнуть DELETE, успешные убрать из очереди.
Оффлайн-очередь: новый ключ в settingsStore `EngineReservationPendingRelease: 'engines.reservation.pendingRelease'` (JSON-массив engineId, cap 50). WHY: жест «закончил работу → вернул двигатель» происходит у станка, а не у Wi-Fi; ВЗЯТИЕ остаётся строго онлайн (требование владельца + серверные часы), очередь только на СНЯТИЕ.
Вызов flush — в syncManager после каждого успешного прогона синка (там же, где обновляется lastResult), обёрнутый в try/catch, без влияния на результат синка.

engineService.ts: в `setEngineAttribute` (строка 775), рядом с существующими гейтами внутреннего номера (строка ~800), добавить
`if (code === ENGINE_RESERVATION_CODE) throw new Error('Резерв меняется кнопками «Взять в работу» / «Вернуть», а не правкой карточки');`
(Правим engineService, а не entityService: у двигателей отдельный write-путь.)

IPC (enginesOpsAudit.ts, рядом с блоком «Engines (write)», строки 63-90):
- `engine:reservation:get` → `requirePermOrThrow(ctx, 'engines.view')` → `getEngineReservation(ctx.sysDb, ctx.mgr.getApiBaseUrl(), id)`;
- `engine:reservation:acquire` → `isViewMode(ctx)` → `viewModeWriteError()`; `requirePermOrResult(ctx, 'engines.edit')`; возвращает `{ok:false,...}`, НЕ throw;
- `engine:reservation:release` → то же + `byAdmin` вычисляется на СЕРВЕРЕ по роли сессии, клиент его не шлёт.

preload/index.ts, блок `engines` (строки 63-81): `reservation: { get, acquire, release }`.
shared/src/ipc/types.ts: `export type EngineReservationInfo = { reservation: EngineReservation | null; serverNow: number }` рядом с EngineDetails (строки 46-94) + три метода в контракте `engines` (строки 852-868). Все опциональные поля — только условным спредом (`exactOptionalPropertyTypes: true`).

**Приёмка:** `corepack pnpm -r typecheck` зелёный (по пакетам последовательно — memory pnpm_typecheck_shared_dist_race). Ручной прогон: acquire онлайн → в локальной `attribute_values` появилась строка с `sync_status='synced'`, в следующем push'е её НЕТ (проверить по matricarmz.log); попытка `window.matrica.engines.setAttr(id,'engine_reservation',{...})` → внятная ошибка; release оффлайн → `{ok:true,queued:true}`, после появления сети резерв снят на сервере, очередь пуста.

### Шаг 7 — Клиент sync: счётчик отбитых по резерву строк в SyncRunResult (без новых статусов и IPC-каналов)

**Файлы:** `electron-app/src/main/services/syncService.ts`, `shared/src/ipc/types.ts`

shared/src/ipc/types.ts, `SyncRunResult` (строки 238-245): добавить `reservedSkipped?: { count: number; holders: string[] }`. Поле бесплатно доезжает в renderer двумя путями: возврат `window.matrica.sync.run()` и `SyncStatus.lastResult` (types.ts:251), который App.tsx поллит каждые 30 с — нового IPC-канала и правки `SyncProgressEvent` (3 точки эмиссии) не требуется.

syncService.ts:3176-3182 (там, где `skipped` сейчас ТОЛЬКО логируется): дополнительно накопить в переменную области функции строки, у которых `parseEngineReservationSkipReason(row.reason) != null`, собрав уникальные `holderLogin`. Прокинуть во ВСЕ успешные return, формирующие `SyncRunResult`, условным спредом: `...(reservedSkippedRows.length > 0 ? { reservedSkipped: { count: reservedSkippedRows.length, holders: [...new Set(holders)] } } : {})` (присваивание `undefined` не скомпилируется при `exactOptionalPropertyTypes: true`).

СОЗНАТЕЛЬНО НЕ ДЕЛАЕМ: ни нового значения `sync_status` ('deferred'/'rejected'), ни таблицы-журнала, ни re-arm прохода. `reserved` — ВРЕМЕННАЯ причина: строка остаётся `pending` и уедет сама, когда резерв снимут или он истечёт. Объём таких строк мал по построению: правки, авторизованные до взятия замка, гейт пропускает (pre-lock grace, шаг 1), а карточка при чужом резерве read-only — накопить отбиваемые правки можно только сознательно, через «Всё равно редактировать», где предупреждение показано явно. Ретрай ограничен сверху TTL. Идемпотентность повторов не трогаем: `syncService.ts:2986` генерирует свежий `randomUUID()` на каждую попытку push (проверено), поэтому `idempotencyCache` (routes/ledger.ts:124-131) старый ответ не реиграет.

Честность формулировки: строки, отбитые по резерву, НЕ помечаются доставленными; если держатель успел изменить те же поля, при следующем pull локальная строка будет перезаписана авторитетной версией (`upsertPulledRowsInChunks` ставит `sync_status='synced'`) — поэтому текст предупреждения на кнопке override (шаг 8) обязан говорить «применятся, только если двигатель освободится и держатель не изменил те же поля», а не «уйдут сами».

**Приёмка:** Двухклиентский прогон: B правит через override двигатель, занятый A → `sync.status.lastResult.reservedSkipped = { count: N, holders: ['<логин A>'] }`; после снятия резерва A те же строки уезжают на следующем прогоне и `reservedSkipped` исчезает. Существующие тесты sync-контура не правились.

### Шаг 8 — UI карточки двигателя: плашка, кнопки, effective read-only, аварийный выход, продление при сохранении

**Файлы:** `electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx`, `electron-app/src/renderer/src/ui/App.tsx`

EngineDetailsPage.tsx (2002 строки), точки:
1) Новые пропы в объявление (строки 335-367): `currentUserId: string; currentUserRole: string;`.
2) Тик времени: `const [nowTick, setNowTick] = useState(Date.now())` + `setInterval(60_000)` с очисткой. Одного `useLiveDataRefresh` (12 с, App.tsx:3396-3406) мало — он обновляет ДАННЫЕ, а истечение зависит от ЧАСОВ.
3) `const reservation = parseEngineReservation(props.engine.attributes?.[ENGINE_RESERVATION_CODE]);` — значение приезжает бесплатно, `getEngineDetails` (engineService.ts:498-506) перебирает ВСЕ defs. `const [overrideUnlock, setOverrideUnlock] = useState(false);` (сбрасывать при смене `props.engine.id`). `const resState = engineReservationState(reservation, { nowMs: nowTick, viewerUserId: props.currentUserId });` `const reservedByOther = resState === 'other' && !overrideUnlock;`
4) `const canEditEnginesEff = props.canEditEngines && !reservedByOther;` и МЕХАНИЧЕСКИ заменить ВСЕ 30 вхождений `props.canEditEngines` (число проверено grep'ом; в предыдущих черновиках фигурировало неверное 42) на `canEditEnginesEff` — включая не-JSX: `saveAttr` (~791), `saveAllAndClose` (~823), `saveDraftNow` (~522), `handleDelete` (~935), автосейв черновика (~711), `keepDraft` (~1008), `canEdit={props.canEditEngines}` на строке 1637. Пропуск любого = «read-only карточка, которая продолжает копить recovery-черновики».
5) `const canEditOperationsEff = props.canEditOperations && !reservedByOther;` → в `canEdit` панели дефектовки (строка 1838). ОТДЕЛЬНО погасить write-кнопки, которые `canEdit` не подчиняются (RepairChecklistPanel.tsx:3002/3037/3063/3097/3131 — «Заявка в снабжение», «Создать ремнаряд», «В ремфонд», «Утиль → склад утиля», «Зафиксировать личные №»): в условных спредах на строках 1855-1858 добавить `&& !reservedByOther` к условиям `props.canCreateWorkOrder` и передачи `onCreateSupplyRequestFromDefects`.
6) Плашка — отдельной строкой СРАЗУ ПОСЛЕ блока вкладок (после строки 1705, вне `hidden`-контейнеров → видна на всех вкладках). Разметка по образцу `EngineDuplicateHint` (строки 58-218: объект `tone`, `padding:'8px 10px'`, `border`, `borderRadius:8`). Тексты: 'other' → `Редактирует ${formatEngineReservationHolder(reservation)} — ${formatEngineReservationUntil(reservation.expiresAt)}`; 'mine' → `Двигатель за вами — ${formatEngineReservationUntil(...)}` (янтарный тон при остатке < 2 ч); 'expired_recently' → `Резерв ${holder} истёк ${...} назад`. ВАЖНО: НЕ хардкодить `fontSize: 12` (болезнь RepairChecklistPanel.tsx:1851 и EngineDuplicateHint:139) — писать `fontSize: 'var(--ui-muted-size, 12px)'`, иначе inline перебивает планшетные токены.
7) Кнопки — через готовый слот `CardActionBar.extraActionsLeft` (рендерится на CardActionBar.tsx:91), компонентом `Button` БЕЗ inline `minHeight/fontSize/padding` (тогда в планшетном режиме сам вырастет до 44px из `--ui-button-md-height`, global.css:342-371): «Взять в работу» при 'free'/'expired_recently'; «Вернуть» при 'mine'; на плашке при 'other' — «Всё равно редактировать» (всем) и «Снять резерв (админ)» при `['admin','superadmin'].includes(props.currentUserRole)`.
8) «Взять в работу»: `saveStatus`-строка «Беру двигатель…» → `window.matrica.engines.reservation.acquire(engineId)` → при `ok:false` показать текст сервера (в т.ч. 409 с держателем) → при успехе `props.onReload()`. Никакого предварительного `sync.run()` не нужно: ответ сервера авторитетный, а строка уже применена локально (шаг 6).
9) «Всё равно редактировать» — `setOverrideUnlock(true)` + подтверждение с честным текстом: «Двигатель занят. Ваши изменения применятся, только если двигатель освободится и держатель не изменит те же поля.»
10) Продление: в `saveAllAndClose` после успешного сохранения — `if (shouldRenewEngineReservation(reservation, { nowMs: Date.now(), viewerUserId: props.currentUserId })) void window.matrica.engines.reservation.acquire(props.engine.id);` Событийно, НЕ по таймеру (таймерный renew = heartbeat в durable-ledger = прод-инцидент M28).
11) `EngineDraftSnapshot` (строки 484-516) и `nextValues` в `saveAllAndClose` (831-848) НЕ трогать — `engine_reservation` не должен попадать ни в черновик, ни в батч сохранения (иначе сработает throw из шага 6 и сломает сохранение карточки). Проверить грепом, что код не просачивается в оба места.

App.tsx: в ОБОИХ местах рендера `EngineDetailsPage` (строки 4186 и 4451 — вторичная карточка сплита и основная) добавить `currentUserId={String(authStatus.user?.id ?? '')}` и `currentUserRole={userRole}` (уже вычислен на строке 1827). Отдельно: баннер в шапке по `syncStatus.lastResult?.reservedSkipped` — рисовать своим блоком по образцу read-only-баннера viewMode (~строки 5357-5371), НЕ через `postLoginSyncMsg` (он отрисуется только при матче регекспа `/(ошиб|не удалось|недостаточно)/i` на App.tsx:4079 и молча исчезнет при переформулировке). Текст: «Двигатель занят (<логины>): N изменений пока не приняты — уйдут, когда резерв снимут».

**Приёмка:** `grep -c 'props\.canEditEngines' EngineDetailsPage.tsx` → 0. CDP-смоук (skill verify / verifier-electron) на TEST-001: «Взять в работу» → плашка с логином+ФИО и временем, кнопка сменилась на «Вернуть»; под вторым логином карточка read-only, кнопки Сохранить/Удалить скрыты, в панели дефектовки погашены «В ремфонд», «Утиль → склад утиля», «Зафиксировать личные №», «Создать ремнаряд», «Заявка в снабжение»; «Всё равно редактировать» снимает read-only и показывает предупреждение; «Вернуть» возвращает редактируемость. Проверить ОБЕ точки рендера (основная и вторичная в сплите) и планшетный режим (data-ui-mode='tablet', 1200×800: кнопка ≥44px, текст плашки не 12px).

### Шаг 9 — Список двигателей: бейдж «занят» на стартовом экране планшетного режима

**Файлы:** `electron-app/src/main/services/engineService.ts`, `shared/src/ipc/types.ts`, `electron-app/src/renderer/src/ui/pages/EnginesPage.tsx`

В `listEngines` (engineService.ts:231) def-id читаются жёстко перечисленным списком, поэтому новый атрибут сам не появится:
- добавить `const reservationDefId = defs[ENGINE_RESERVATION_CODE];` рядом со строкой 240 и `reservationDefId` в массив `baseDefIds` (строки 261-275);
- в per-engine цикле (со строки 322) взять `rowValues.get(reservationDefId)` → `parseEngineReservation` → `isEngineReservationLive(r, now)`; при live заполнить поля УСЛОВНЫМ СПРЕДОМ (`exactOptionalPropertyTypes: true`).
shared/src/ipc/types.ts, `EngineListItem` (строки 10-45): `reservedByLabel?: string; reservedByUserId?: string; reservedUntil?: number;`.
EnginesPage.tsx: иконка замка 🔒 в строке списка + тултип `reservedByLabel` + «до <время>».
WHY (аргумент судьи 3): стартовый экран планшетного режима — именно СПИСОК; без бейджа оператор идёт к двигателю и узнаёт о замке, только открыв карточку. Это же место — единственная защита от dual-source read (M23): один код атрибута во всех read-путях.

**Приёмка:** Клиент A взял TEST-001 → у клиента B после pull в списке двигателей на строке TEST-001 виден замок с логином+ФИО держателя и временем; после снятия резерва бейдж пропадает без перезапуска (обновление по существующему polling).

### Шаг 10 — Тесты, гейты, документация, порядок раската

**Файлы:** `shared/src/domain/engineReservation.test.ts`, `backend-api/src/services/sync/ledgerAuthzGuard.test.ts`, `backend-api/src/services/engineReservationService.test.ts`, `docs/plans/tablet-shop-floor.md`, `docs/GOTCHAS.md`, `docs/PENDING_FOLLOWUPS.md`

Тесты — по шагам 1/3/5 (кейсы перечислены в их acceptance). ВАЖНО: дописывать в СУЩЕСТВУЮЩИЙ `backend-api/src/services/sync/ledgerAuthzGuard.test.ts` (248 строк, готовый table-aware мок), а не заводить новый файл — утверждение «тестов на гейт нет» ложно. В моках держать только простые select (мок `makeTxSelectFromTableMap` не умеет `.innerJoin` и игнорирует `.where`), код атрибута дофильтровывать в JS.

Гейты перед мержем (CLAUDE.md §Autonomy): build `shared`+`ledger` → `corepack pnpm -r typecheck` (по пакетам последовательно) → `lint` → `corepack pnpm -F @matricarmz/backend-api test` (в т.ч. существующие sync.test.ts и presenceNotLedgered.test.ts — доказательство, что горячий write-путь не задет) → CI 'Check Sync Contract' (должен пройти БЕЗ изменений — `SyncTableName` не трогаем) → CDP e2e-смоук (skill `verify`).

Приёмка на дев-стенде (обязательна, два клиента):
1. A берёт TEST-001 → B после pull видит бейдж в списке и плашку в карточке, карточка read-only.
2. B жмёт «Всё равно редактировать», правит → push → `reservedSkipped` в статусе, баннер показан, критсобытий `server.authz.denied` НЕ появилось.
3. Три подряд авто-синка: `matricarmz.log` показывает, что отбитые row_id действительно ретраятся (это ожидаемо и ограничено TTL), объём — единицы строк.
4. A жмёт «Вернуть» → у B те же строки уезжают и применяются.
5. Оффлайн-сценарий: B уходит в оффлайн ДО взятия замка A, правит карточку, возвращается — правки НЕ отбиты (pre-lock grace). Это ключевая проверка фичи.
6. B оффлайн жмёт «Вернуть» свой резерв → намерение в очереди → при появлении сети резерв снят.
7. Часы планшета сдвинуть на +2 суток: замок продолжает определяться корректно (все времена серверные).
8. Роль engineer (без masterdata.edit): резерв работает — значит def приехал из seed.

Доки: в `docs/plans/tablet-shop-floor.md` §Ф2 зафиксировать четыре решения — (а) хранение: один json-EAV `engine_reservation`, писать может только сервер; (б) точка гейта перенесена из `applyPushBatch` в `partitionLedgerInputsByAuthz` (обоснование про ledger-replay); (в) TTL 12 ч + событийное продление (закрывает открытый вопрос №3); (г) операции гейтятся по белому списку типов. В `docs/GOTCHAS.md` — две записи: «мягкий гейт в applyPushBatch = расхождение ledger↔PG при replay, ставить в pre-ledger слой» и «advisory-резерв: гейт видит engine-entity + операции белого списка; смежные сущности не покрыты». В `PENDING_FOLLOWUPS.md` — в Ф3: UI «мои неприменённые изменения» со снимком значения; `getEngineDetails` (engineService.ts:501-506) читает значения без `isNull(deletedAt)`/`orderBy`; `stale-pair-guard` в applyPushBatch (999-1029) не кладёт строки в `skipped`.

Раскат: миграций НЕТ → шаг `db:migrate` на проде не нужен, деплой обычный (build серверных пакетов + рестарт). Клиент и сервер выпускать ОДНИМ релизом; страховка от M17 — kill-switch `MATRICA_ENGINE_RESERVATION_GATE=off` в env systemd (по умолчанию гейт ВКЛЮЧЁН: замков до раската клиента физически не существует, потому что взять их может только новый клиент; выключатель нужен для мгновенного отката без передеплоя).

**Приёмка:** Все гейты зелёные; CI 'Check Sync Contract' проходит без изменений в контракте; 8 пунктов приёмки выполнены; в теле PR явно перечислены отклонение от буквы плана (точка гейта), список гейтимых типов операций, ограничение охвата и решение по TTL.

## Гейты

- build: corepack pnpm -F @matricarmz/shared build && corepack pnpm -F @matricarmz/ledger build
- corepack pnpm -r typecheck — гонять ПО ПАКЕТАМ ПОСЛЕДОВАТЕЛЬНО (memory pnpm_typecheck_shared_dist_race: гонка пересборки shared/dist даёт ложный TS2305)
- corepack pnpm -r lint
- corepack pnpm -F @matricarmz/backend-api test — включая НЕтронутые sync.test.ts и presenceNotLedgered.test.ts (доказательство, что applyPushBatch и writeSyncChanges не задеты)
- CI 'Check Sync Contract' — должен пройти без изменений: SyncTableName / syncRowSchemaByTable / SyncTableRegistry не трогаем вовсе
- grep -c 'props\.canEditEngines' electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx → 0 (было 30)
- CDP e2e-смоук через skill verify / verifier-electron на TEST-001 (UI-правки) + проверка планшетного режима data-ui-mode='tablet' 1200×800
- Двухклиентская приёмка на дев-стенде: 8 пунктов из шага 10, в т.ч. оффлайн pre-lock grace и отсутствие server.authz.denied в критсобытиях
- CI на PR зелёный; прод-деплой без db:migrate (миграций нет), после рестарта curl /health и /updates/status

## Решения по открытым вопросам (приняты 2026-07-22)

**Q1.** TTL 12 ч — подтвердить у владельца. Компромисс: 12 ч + событийное продление при сохранении рассасывает забытый резерв к следующему утру (мастеру не нужен админ), 24 ч переживают ночь, но забытый замок блокирует соседа ровно в начало следующей смены. Меняется одной константой ENGINE_RESERVATION_TTL_MS.

**Q2.** Белый список гейтимых типов операций: сейчас defect, defect_act, engine_inventory, kitting, completeness, completeness_act, claim_act, disassembly, part_status_event, repair_fund_instance, repair_fund_requirement. Спорны part_status_event и repair_fund_* — их может писать и складской контур. Подтвердить у владельца/по факту обкатки; список — одна константа в shared.

**Q3.** Отклонение от буквы плана: гейт в partitionLedgerInputsByAuthz вместо applyPushBatch (tablet-shop-floor.md:74). Обоснование — ledger-replay воскресил бы отклонённые строки. Требует явного «да» владельца одной строкой в PR.

**Q4.** Резерв стал server-managed: клиент не может записать атрибут ни при какой роли. Значит залипший замок чинится только кнопкой «Снять резерв (админ)» в карточке или DELETE-эндпойнтом, но НЕ обычной правкой мастер-данных. Согласовать, нужна ли кнопка снятия ещё и в web-admin (в Ф2 её нет).

**Q5.** Kill-switch MATRICA_ENGINE_RESERVATION_GATE по умолчанию ВКЛЮЧЁН (в отличие от предложения V2 «off в первом релизе»). Обоснование: замков до раската нового клиента не существует, а выключенный по умолчанию гейт легко забыть включить. Подтвердить.

## Принятые риски

- Латентность advisory-схемы: сосед узнаёт о замке не раньше своего следующего pull (база 5 мин, при активности 15-45 с). Оба могут начать работу одновременно; страховки — LWW, бейдж в списке и TTL. Принципиальное свойство схемы, не баг.
- Охват гейта ограничен engine-entity, её attribute_values и операциями белого списка. Правки смежных сущностей (детали ремфонда как самостоятельные записи, номенклатура, файлы, складские документы) НЕ блокируются. Зафиксировать в PR, иначе прочтётся как баг.
- Отбитые по резерву строки остаются pending и ретраятся каждый прогон до снятия/истечения замка. Не вводим четвёртое значение sync_status (все три судьи назвали его ловушкой с режимом отказа «строки не уедут никогда»). Объём мал по построению: pre-lock grace пропускает всю оффлайн-работу, а накопить отбиваемые правки можно только сознательно через «Всё равно редактировать». Ретрай ограничен сверху TTL.
- Если держатель правил ТЕ ЖЕ поля, при следующем pull локальная отбитая строка будет перезаписана авторитетной версией (upsertPulledRowsInChunks ставит sync_status='synced') — правка оператора исчезнет. Поэтому текст override честный («применятся, только если двигатель освободится и держатель не изменил те же поля»), а полноценный разбор «мои неприменённые изменения» со снимком значения вынесен в Ф3.
- Нет БД-уникальности «один активный резерв на двигатель» как отдельного инварианта и нет индекса под запрос «все активные резервы». Атомарность даёт уникальный индекс attribute_values_entity_attr_uq + серверный CAS; массовой отчётности по резервам не планируется.
- Кеш getLiveEngineReservations 10 с и два backend-процесса: второй процесс может до 10 с видеть устаревшее состояние (пропустить свежий замок или подержать снятый). Для advisory приемлемо.
- «Взять в работу» работает только онлайн (требование владельца + серверные часы). Оффлайн-оператор карточку не блокирует и работает как раньше — деградация мягкая.
- getEngineDetails (engineService.ts:501-506) читает значения без isNull(deletedAt) и без orderBy. Мы всегда пишем ЗНАЧЕНИЕ (releasedAt), никогда soft-delete, поэтому в Ф2 это не стреляет; общий фикс — follow-up (регрессионный риск на все атрибуты карточки).
- Два процесса деплоя (клиент + сервер) должны выехать одним релизом; страховка от M17 — kill-switch в env, а не договорённость о порядке.

## Состязательное ревью (2026-07-22, 4 измерения × скептик на каждую находку)

16 находок, 9 подтверждено скептиком, 7 опровергнуто. Исправлено в этом же PR:

| # | Что | Где |
|---|---|---|
| 1 | **Backstop по коду атрибута обходился** подложным `attribute_defs` из того же батча (дыра касалась и employee-auth backstop'а) | `ledgerAuthzGuard.ts` + регресс-тест, GOTCHAS **M36** |
| 2 | **CAS не защищал:** `writeReservationValue` перечитывал строку сам, сравнивая её с собой → двойной захват | `engineReservationService.ts` — одно чтение на решение и на CAS |
| 3 | **Троттлинг продления не работал:** считался от замороженного `startedAt` → после 6 ч ledger-запись на КАЖДОЕ сохранение (класс M28) | `shouldRenewEngineReservation` — считаем по остатку до `expiresAt` |
| 4 | **Резерв не долетал до открытой карточки:** `sameEngineDetails` сравнивал только поля сущности, а замок живёт в `attribute_values` | `App.tsx` |
| 5 | Клиентский гейт стоял только в `engineService` — общий путь мастер-данных писал атрибут, строка навсегда застревала в pending | `entityService.ts` |
| 6 | `flush` отложенных снятий шёл под `inFlight` → при недоступном сервере вешал синк | `syncManager.ts` — без `await` |
| 7 | «Взять в работу» без сети: сырая ошибка / ~90 с ожидания | `engineReservationClient.ts` — `attempts:1` + русский текст |
| 8 | «Взять в работу» на несохранённой карточке → «HTTP 404» (deferred create) | понятный текст «Сначала сохраните карточку» |
| 9 | Recovery-черновик удалялся, ни разу не показавшись, при чужом замке | гейт восстановления — по праву, а не по эффективному |

**Опровергнуто скептиком (не чиним):** массовый лок как DoS; «скос часов пробивает замок» (это и есть pre-lock grace, несущая конструкция); «read-only карточка выбрасывает набранное» (цепочка недостижима); голодание push-пачки отбитыми строками.

**Осталось наблюдением:** прохождение по pre-lock grace при живом чужом замке нигде не логируется — в проде не измерить реальный скос часов на планшетах. Если понадобится — дешёвая метрика и подкрутка `ENGINE_RESERVATION_PRE_LOCK_GRACE_MS`.
