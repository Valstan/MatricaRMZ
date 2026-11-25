# Глобальная линза — что уже сделано и что надо доработать

**Вопрос линзы:** есть ли уже готовый глобальный обработчик, который делает это? Не «можно ли сделать», а «уже сделано ли».

**Ответ:** готовые обработчики **есть**, но правило применено только к соседним таблицам ⇒ нужны **доработки существующих модулей**, новый модуль не нужен.

## Что нашлось (источник факта)

| Что | Где | Что уже умеет | Чего не хватает |
|---|---|---|---|
| No-op ⇒ без seq и без записи журнала | `backend-api/src/services/sync/syncWriteService.ts` → `findUnchangedAttributeValueRows` (строки 216–262), фильтр `pack.rows.filter(row => !noopAttributeValueIds.has(...))` (строка 326) | Для `attribute_values`: содержимое совпало ⇒ строка не идёт в журнал, но **подтверждение клиенту уходит как обычно** (`applied_rows` собирается из `applyPushBatch`) | Тот же фильтр для `erp_engine_inventory_lines` — правило написано **второй раз, но только для одной таблицы** |
| Отказ по устареванию назван | `backend-api/src/services/sync/applyPushBatch.ts` → `filterStaleBySeqOrUpdatedAt` (строки 548–658), `LWW_REJECTED_REASON` | Для `operations` отказ назван `lww_rejected` (строка 1274: `staleReason: LWW_REJECTED_REASON`) | Для `erp_engine_inventory_lines` (строка 1430) `staleReason` **не передан** ⇒ отказ уходит с причиной `conflict` |
| Клиент снимает `pending` по названному отказу | `electron-app/src/main/services/sync/skipReasonPolicy.ts` → `lwwRejectedByTable` (строки 37–48) | Политика **таблично-независимая**: любой строке с причиной `lww_rejected` снимается `pending` | — (правка клиента не нужна, если сервер назовёт отказ) |
| Клиент помнит подтверждённые сервером строки | `electron-app/src/main/services/sync/confirmedRows.ts` + `syncService.ts:6098` | Строка, подтверждённая сервером, не возвращается в очередь самолечением M52 | Модуль **не в релизе 3.146.0** (слит после тега) |
| Самолечение «отправлено, но не подтверждено» | `electron-app/src/main/services/syncService.ts` → `requeueUnconfirmedRows` (строки 1239–1265), вызовы 1274–1277 | Возвращает в очередь строки `synced` без номера | Вызывается только для `entities`/`attribute_defs`/`attribute_values`/`operations` — **строки списка деталей не охвачены** |
| Снимок диагностики клиента | `electron-app/src/main/services/sync/diagnosticsReporter.ts` → `buildDiagnosticsSnapshot` (строки 203–238) | Снимает `entity_types`, `entities`, `attribute_defs`, `attribute_values`, `operations` | **`erp_engine_inventory_lines` в снимок не входит** ⇒ сервер не видит этот класс ни на одной платформе |
| Отправка снимка | `electron-app/src/main/services/syncService.ts:6277–6289` | Снимок уходит раз в 10 минут | Отправка стоит **после** pull'а ⇒ при упавшем/висшем pull снимок не уходит; ошибка отправки глотается (`.catch(() => {})`) |
| Бюджет пуша | `electron-app/src/main/services/sync/pushBudget.ts`, `syncService.ts:1307–1367` | Отсечение таблицы бюджетом **называется** в логе | — |
| Серверное автолечение по дрейфу | `backend-api/src/services/diagnosticsAutohealService.ts` | Включено по умолчанию (`MATRICA_SYNC_AUTOHEAL_ENABLED ?? '1'`), чинит `force_full_pull_v2`/`reset_sync_state_and_pull`/`deep_repair` | Решает **по клиентским снимкам** ⇒ android-парк (снимков нет) автолечением не чинится |

## Решение линзы

**Действие — доработать существующие модули:**

1. `syncWriteService.ts` — обобщить детектор no-op на таблицы, где содержимое строки сравнимо (сейчас только `attribute_values`), добавить `erp_engine_inventory_lines`; **вторую копию правила не писать**.
2. `applyPushBatch.ts` — передать `staleReason: LWW_REJECTED_REASON` для `erp_engine_inventory_lines` (клиентская политика уже готова).
3. `diagnosticsReporter.ts` — добавить таблицу строк списка деталей в снимок.
4. `syncService.ts` — отправлять снимок **независимо от исхода pull'а** и не глотать ошибку отправки молча.

**Новый глобальный модуль не нужен** — всё живёт в существующих модулях синка; новая строка в `docs/GLOBAL_MODULES.md` не требуется (реестр описывает модули уровня «кит/правило программы», а не сервисы синка).
