# 🟡 Печатные формы: офлайн-шаблоны (таблицы вне sync-контракта)

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Долгие хвосты / на будущее»
**Нить:** промты КАРМАНА #4 + #5 (модуль печатных форм), сделано 20.11.2026.

## Суть

Шаблоны печатных форм и документы живут в **серверных таблицах вне sync-контракта**
(`print_templates`, `print_documents`) — решение нити, обоснование в
[`plans/print-forms-module-2026-11.md`](../plans/print-forms-module-2026-11.md) §«Решение по
контуру данных»: шаблоны и сегодня читались по сети в момент печати
(`ppe:printTemplates:list` → REST), а локальная реплика `ppe_print_templates` формой не
использовалась; добавление таблиц в контракт — это ~15 файлов контура доставки ради копии,
которую печать не читает.

**Чем платим:** печать по шаблону требует связи с сервером. Офлайн (сервер недоступен)
печать деградирует до «без шаблона» — печатаются все пункты. Для карточки СИЗ это не
регрессия: там остался запасной путь через прежний шаблон `ppe_print_templates`.

## Что сделать, если владелец попросит офлайн-печать

1. Перевести обе таблицы в sync-контракт по образцу `ppe_print_templates`:
   `SyncTableName` (shared/src/sync/tables.ts), реестр строки (shared/src/sync/registry.ts),
   схема DTO (shared/src/sync/dto.ts), карта доменов (shared/src/sync/syncTableDomains.ts),
   `SYNC_TABLE_OWNERSHIP` + `TABLE_REQUIREMENT` (shared/src/domain/ledgerAuthz.ts),
   дверь в [`WRITE_DOORS.md`](../WRITE_DOORS.md);
2. сервер: публикатор зеркала (по образцу `ppeSyncPublisherService.ts`), выборка в
   `pullChangesSince.ts` и `pgSyncTables.ts`, бэкстоп в `applyPushBatch.ts`;
3. клиент: sqlite-дубль (electron-app/src/main/database/schema.ts + миграция в
   `electron-app/src/main/database/migrate.ts`, и android-app/src/db/migrate.ts), ветки в
   `syncService.ts` и `errorRecovery.ts`;
4. чтение шаблона — из локальной реплики, запись — по-прежнему серверная дверь.

**Гейт:** сборка `shared` + `ledger`, `pnpm -r typecheck`, lint, `pnpm -r test`,
сторожи `syncTableOwnership.guard` (shared и backend) и `check-sync-contract` в CI.

## Что не трогать

- `ppe_print_templates` — её имя живёт в sync-контракте; переименование ломает контур
  доставки. Использовать как образец, а не как цель.
