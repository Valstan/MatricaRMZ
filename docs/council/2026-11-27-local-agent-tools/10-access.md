# 10 — Хранитель прав (`access`): действия агента от имени оператора

**Вердикт.** Слой «право + текст отказа» **не заводить** — он в клиенте уже есть (`ipcContext.ts` + `sectionGate.ts`); новый реестр инструментов должен звать существующие двери и возвращать их отказы как есть: право агента = право сессии оператора, раздел = membership оператора, авторитет = сервер. **Уверенность: высокая** (часть «слой уже есть» — высокая; часть «реестр живёт в main, а не в renderer» — средняя).

**Варианты (цена и риск).**

- **А (рекомендую).** Реестр инструментов агента — новый модуль в main-процессе рядом с `services/localMiniMax/` (`services/agentTools/registry.ts`). Объявление: `{id, titleRu, requires: PermissionCode[], section, level, handler}`. `handler` зовёт **те же** сервисные функции, что и UI; гейт — `requirePermOrResult`/`requireAnyPermOrResult` (`electron-app/src/main/ipc/ipcContext.ts:44-72`) + раздел (общая функция из `sectionGate.ts`) + `isViewMode`; отказ возвращается **текстом гейта**, свой текст запрещён; строка аудита пишется ДО записи. Цена: 1 модуль + 1 экспорт из `sectionGate.ts` + 2 строки в реестрах подписей + (по согласованию с сервером) 1 строка в `actionText`. Риск: реестр «размажется» по разделам — лечится сторожем «инструмент объявлен только в общем реестре».
- **Б.** Реестр в renderer, рядом с `objectActions.ts`. Цена: быстрее. Риск: **высокий** — право и текст отказа пришлось бы завести второй раз (в renderer), а гейт раздела живёт только в main. Это ровно та вторая копия, которой предостерегает линза. Не рекомендую.
- **В («не делать»).** Оставить агента read-only (мост `dbBridge.ts` — только чтение), запись не открывать. Цена: ноль кода, ноль риска. Минус: критерий брифа «агент может вызвать разрешённое действие» не закрыт — держать как запасной вариант, если за день не собралась проверка прав по каждой двери.

## 1. Где живёт «право + текст отказа»

Нигде нового. **Переиспользовать:** коды прав — `shared/src/domain/permissions.ts:1` (`PermissionCode`; общий на клиент/сервер/синк, `docs/GLOBAL_MODULES.md:27`); проверка права + текст отказа — `electron-app/src/main/ipc/ipcContext.ts:44-72` (`permission denied: <код> — нет права «<код>»`; **префикс `permission denied` менять нельзя** — `ipcContext.ts:41-42`); раздел + его тексты — `electron-app/src/main/ipc/sectionGate.ts:448-462` («Нет доступа к разделу «…»», «…только для просмотра», «данные о доступах не обновлены (нужен синх)»).

**Не трогать как источник прав:** каталог действий по объекту (`shared/src/domain/objectCapabilities.ts:63`, `electron-app/src/renderer/src/ui/utils/objectActions.ts:80-89`) — там «что умеет объект» и подписи кнопок; **текста отказа там нет**, а `available` — это видимость, а не право (`docs/CONSTITUTION.md:23`, ст. 5). **Серверный `backend-api/src/services/ai/llmTools.ts:32-56`** — образец ФОРМЫ (`def`+`requires`+`handler`, `can(ctx,perm)`, свой `denyMessage`), но не код и не источник прав: контур другой (серверные права, серверная БД).

**Нельзя трогать и переписывать:** доменные проверки дублей (`shared/src/domain/productionProgram.ts:1429` `productionProgramMergeRows`, `:1588` `productionProgramEngineMatch`, `shared/src/domain/engineBulkIntake.ts:64`) — инструмент обязан их **вызвать**.

## 2. Как проверяется право оператора в действии по команде агента

Право агента = право сессии оператора: `ctx.currentPermissions()` (`electron-app/src/main/ipc/registerIpc.ts:147-156`; сессия обновляется `authSync` → `/auth/me`, `electron-app/src/main/services/authService.ts:112-141`). Гейт двери: `requirePermOrResult(ctx, 'production_program.edit')` (`ipcContext.ts:49`), несколько прав — `requireAnyPermOrResult` (`ipcContext.ts:62`); раздел — `sectionGate.ts` (префикс `productionProgram:` → `production_program`, `:39`; write-каналы `:160-164`; editor-уровень `:417`); режим просмотра — `isViewMode`/`viewModeWriteError` (`ipcContext.ts:74-83`).

**Образец целиком (право + раздел + аудит до записи):** `engine:delete` — `electron-app/src/main/ipc/register/enginesOpsAudit.ts:141-166` (право `:143`, аудит `:155` **ДО** записи, отказ если аудит не записался `:162`).

Последняя линия — сервер: `requirePermission(PermissionCode.ProductionProgramEdit)` (`backend-api/src/routes/productionProgram.ts:79,87,95,123,137`); право `production_program.edit` роль не даёт, кроме superadmin (`backend-api/src/auth/permissions.ts:63`), остальным — поимённый override (`docs/WRITE_DOORS.md:58`). ⚠️ **У клиентского `productionProgram:saveRows` (`electron-app/src/main/ipc/register/productionProgram.ts:218-251`) локальной проверки права нет** — только view-mode; гейт только серверный. Значит в реестре право проверяем сами тем же хелпером — иначе отказ придёт поздно и не по-русски для оператора.

## 3. Что должно попасть в аудит

Журнал — таблица `audit_log` (`electron-app/src/main/database/schema.ts:110`), запись — `addAudit` (`electron-app/src/main/services/auditService.ts:11-36`), синх-таблица **append-only** (`shared/src/domain/syncTableDomains.ts:65`, `shared/src/domain/ledgerAuthz.ts:75-77`) ⇒ строка клиента доходит до серверного журнала.

Агентское действие пишет **приложение, а не агент**: `actor` = оператор (`ctx.currentActor()`, `registerIpc.ts:134-138`), `action` = **новое семейство `agent.<домен>.<операция>`**, `payload` = `{source:'agent', tool, model, questionId, programId, added, skipped}`. Почему `action`, а не только payload: «текст действия» в журнале владельца считается из кода действия (`backend-api/src/services/statisticsAuditService.ts:111-135`), payload там читается только для двух кодов. Раздел строки считается по префиксу кода — и это **общее правило** `shared/src/domain/auditObject.ts:191` (`SECTION_BY_ACTION_PREFIX`), которым пользуется и сервер (`backend-api/src/services/auditObjectService.ts:23,166`; на показе пересчитывается, `:632-656`). Значит: **добавить префикс `agent.` в `shared/src/domain/auditObject.ts` — раздел в журнале станет правильным без правок сервера**; остаётся строка подписи в `shared/src/labels/auditAction.ts` (клиент) и — для серверного журнала — строка в `statisticsAuditService.actionText` (зона сервера, на согласование). Порядок записи — как в `engine:delete`: аудит ДО записи, запись не идёт, если аудит не записался (`enginesOpsAudit.ts:155-162`). Плюс: агентское действие видно оператору **в ответе чата** («добавлено 3, отклонено 2: Д-100 уже в плане»), а не только в журнале.

## 4. Чем рискует агент с правом «на чтение»

Правом он не превысит оператора, если каждый инструмент проходит гейт двери (п. 2). Риски другие: **(а) инъекция через данные** — агент читает реплику целиком (`electron-app/src/main/services/localMiniMax/dbBridge.ts:61-94`: любой SELECT по любой таблице, **без гейта прав и разделов**), и текст в заметках/названиях может подсказать агенту вызвать запись ⇒ правило: инструмент делает только то, что оператор прямо попросил, никаких «удалить/заменить» без подтверждения. **(б) читает шире, чем видит оператор** — гейт разделов на мосте не действует ⇒ закрытые разделы («Дети», закрытые наряды) агент прочитать может (оператор их и так видит в файле реплики на своей машине — но UI прячет): решение владельца — оставляем как есть, но инструменты агента по «Детям» и закрытым нарядам не заводим. **(в) права устаревают** — клиентская копия обновляется при `authSync` (`authService.ts:112-141`), до этого отозванное право на клиенте ещё есть ⇒ сервер остаётся последней линией (`docs/CONSTITUTION.md:23`). **(г) неотличимость от клика** — без п. 3 оператора можно обвинить в том, чего он не делал.

**Отказы с понятной причиной (тексты — из гейтов, свои запрещены):** `permission denied: production_program.edit — нет права «production_program.edit»`; `Раздел «Производственная программа» доступен вам только для просмотра` / `Нет доступа к разделу «Производственная программа» — обратитесь к администратору` / `…данные о доступах на этом устройстве не обновлены (нужен синх)` (`sectionGate.ts:456-461`); `view mode: data is read-only (exit backup view mode to edit)` (`ipcContext.ts:81`); доменный отказ (не право, но тоже не «сделано»): «двигатель Д-100 уже есть в плане», «номер встречается дважды в списке».

## 5. Что НЕ надо делать

1. Не заводить «право + текст отказа» рядом с `objectActions.ts`/`objectCapabilities.ts` — там ни прав, ни текста отказа; `available` — видимость.
2. Не копировать `llmTools.ts` — другой контур; брать форму, не код.
3. Не давать агенту «свои» права (`agent.*` в `PermissionCode`) — иначе появится второй авторитет.
4. Не делать «универсальный канал вызова любого IPC»: гейт разделов работает по префиксам каналов (`sectionGate.ts:29-93`), канал агента под них не попадёт ⇒ обход гейта разделов и любой будущей двери.
5. Не расширять `dbBridge` на запись и не добавлять таблицу в схему реплики (решение владельца, бриф).
6. Не переписывать доменные проверки дублей — вызывать.
7. Не давать агенту удаление/замену набора строк без явного подтверждения оператора.
8. Не «проглатывать» отказ: агент не отвечает «сделано», если дверь отказала.

## Чем проверяется за день (стенд)

1. Оператор с `production_program.edit` и разделом `production_program:editor`: агент добавляет 2 новых номера и 1 существующий → в ответе «добавлено 2, отклонено 1 (уже в плане)», в плане 2 новые строки, дубля нет.
2. Тот же вопрос без права → в ответе дословно `permission denied: production_program.edit — нет права «production_program.edit»`; в плане **ничего** не изменилось.
3. Оператор с разделом только на просмотр → «Раздел «Производственная программа» доступен вам только для просмотра»; строк не добавлено.
4. В журнале (клиентский `audit_log` и серверный «Администрирование») есть строка `action=agent.…`, `actor=<логин оператора>`, payload `source:'agent'`; ложной строки «оператор нажал кнопку» нет.
5. Попытка вызвать несуществующий/чужой инструмент даёт отказ, а не запись (защита от «туннеля»).

## Что заставит передумать (фальсификатор)

- **(а)** Окажется, что часть нужных дверей не имеет клиентской проверки права и полагается только на сервер (как `productionProgram:saveRows`) — тогда клиентская проверка в реестре станет второй, расходящейся копией, и правильным будет «доверять серверу» (цена: отказ приходит не по-русски и с задержкой ⇒ нужен серверный текст отказа — зона сервера).
- **(б)** Владелец решит, что «действие по команде нейросети» должно быть **отдельным разделом** журнала («Нейросеть»), а не префиксом кода ⇒ меняется фильтр журнала (`electron-app/src/renderer/src/ui/pages/SuperadminAuditPage.tsx:125`) и объём правок растёт.
- **(в)** Окажется, что у людей с `production_program.edit` часто нет раздела `production_program:editor` (или наоборот) ⇒ приоритет гейта (раздел vs право) меняется местами, и отказ станет «нет раздела» вместо «нет права».

## Доменная добавка (по уставу: имя операции/раздела + где живёт гейт)

- **Ведение производственной программы**: раздел `production_program` (`shared/src/domain/sectionAccess.ts:26`), право `production_program.edit` (`shared/src/domain/permissions.ts:155`), гейт раздела — `electron-app/src/main/ipc/sectionGate.ts:39,160-164`, гейт права — `ipcContext.ts:49` + сервер `backend-api/src/routes/productionProgram.ts:95`, владение таблицами `erp_production_programs`/`erp_production_program_rows` = **server** (`shared/src/domain/sectionAccess.ts:427-428`, `docs/WRITE_DOORS.md:54`) ⇒ клиентский push в них закрыт backstop'ом, ПП пишется только серверной дверью.
- **Удаление двигателя**: право `engines.edit` + раздел `production`; гейт — `electron-app/src/main/ipc/register/enginesOpsAudit.ts:143` + `sectionGate.ts:30,134`, аудит до записи — `:155`.
- **Журнал действий**: право `audit.view` (`shared/src/domain/permissions.ts:134`), гейт — `sectionGate.ts:92` (`audit:list` → администрирование), владение строкой — append-only (`shared/src/domain/ledgerAuthz.ts:75-77`).

**Основные источники:** `electron-app/src/main/ipc/ipcContext.ts`, `electron-app/src/main/ipc/sectionGate.ts`, `electron-app/src/main/ipc/register/enginesOpsAudit.ts`, `electron-app/src/main/ipc/register/productionProgram.ts`, `electron-app/src/main/services/auditService.ts`, `shared/src/domain/permissions.ts`, `shared/src/domain/sectionAccess.ts`, `shared/src/domain/auditObject.ts`, `backend-api/src/routes/productionProgram.ts`, `backend-api/src/services/ai/llmTools.ts` (образец), `docs/WRITE_DOORS.md`, `docs/CONSTITUTION.md`.

**Покрытие.** dimensions_done: [клиентские гейты права/раздела/режима просмотра, двери записи (образец `engine:delete`), серверные двери ПП и право `production_program.edit`, клиентский журнал действий и его синх на сервер, правило подписи раздела журнала (shared + сервер), мост «реплика→агент» и его read-only граница, каталог действий по объекту, серверный образец реестра инструментов, владение таблицами ПП] · dimensions_failed: [`docs/CODEBASE_MAP.md` целиком не читался; `backend-api/src/services/sync/ledgerAuthzGuard.ts` не читал (порядок гейтов взят из `docs/WRITE_DOORS.md:21`); `backend-api/src/services/ai/llmTools.ts` прочитан не полностью (первые ~410 строк из 60 КБ); диалог «Добавить списком» прочитан до строки 190 (путь записи дальше не проверял — зона Производственника); живой прогон (CDP/стенд) не делал — только чтение кода; транспорт «агент → приложение» (MCP-сервер/канал) не выбирал — зона Оболочщика, рассматривал только требования к гейтам]
