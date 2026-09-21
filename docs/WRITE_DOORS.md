# Двери записи и права — таблица к мандату D-096 (идея #015)

> Отвечает на вопрос «через какую дверь можно записать строку X и кто это проверяет». Заведена 21.09.2026; полная версия — к **16.10** (календарь `PENDING_FOLLOWUPS`). Правило проекта: все серверные записи в sync-таблицы идут через `writeSyncChanges` (`AGENTS.md` §Project overview); эта таблица проверяет, где правило держится гейтом, а где — привычкой.

## Покрытие (честно: N из M)

| Дверь | Всего | Разобрано | Статус |
|---|---|---|---|
| **Ledger push** (`POST /ledger/tx/submit` → `applyLedgerTxs` → `partitionLedgerInputsByAuthz` → `writeSyncChanges`) | 25 таблиц контракта | **25** | ✅ таблица ниже, механизм `SYNC_TABLE_OWNERSHIP` + два сторожа |
| **`/changes/:id/apply`** (та же цепочка через `applyLedgerTxs`) | 1 | 1 | ✅ тот же гейт (`changesApplyAuthz.test.ts`) |
| **REST-ручки записи** (`router.post/put/patch/delete` в `backend-api/src/routes/`) | 171 обработчик в 33 файлах | **0** | ⏳ к 16.10 |
| **Скрипты-импортёры / обслуживание** (`backend-api/src/scripts/`) | 94 файла; 18 пишут через `writeSyncChanges`, 14 — прямым `db.insert/update/delete` | **0** | ⏳ к 16.10; прямые записи в sync-таблицы — кандидаты на M6/M15 |
| **Фоновые задачи** (сервисы с `setInterval`/расписанием) | 10 | **0** | ⏳ к 16.10 |

Не смотрели и почему: три нижних строки — отдельный проход по каждому обработчику с вопросом «какой actor, какой гейт, идёт ли через `writeSyncChanges`»; за один день 21.09 закрыт механизм ledger-двери, потому что именно она принимает строки от всего парка без участия человека.

## Ledger push — 25 таблиц контракта

Источник правды — `shared/src/domain/ledgerAuthz.ts` (`SYNC_TABLE_OWNERSHIP`, `TABLE_REQUIREMENT`, `ENTITY_TYPE_REQUIREMENT`, `OPERATION_TYPE_REQUIREMENT`). Таблица ниже — снимок 21.09; расхождение снимка с кодом ловят сторожа `syncTableOwnership.guard.test.ts` (shared: карта ↔ requirement ↔ backstop; backend: карта ↔ проверки в `applyPushBatch`).

Порядок гейтов на пути одной строки: `ensureSyncTable` (имя вне 25 → отказ всего батча) → backstop server-managed (любая роль, включая суперадмина) → backstop строки этапа работ → backstop защищённых атрибутов → advisory-резерв двигателя → закрытые наряды → editor-уровень раздела → **обход для не-операторских ролей** → requirement по типу/таблице для операторов → подпись в журнал → построчные проверки в `applyPushBatch`.

| Таблица | Владение | Кто проверяет | Что клиент может |
|---|---|---|---|
| `entity_types` | schema | requirement `open` | регистрировать типы (ensureAttributeDefs) |
| `attribute_defs` | schema | `open` + backstop по коду (`system_role`, `login`, …) | регистрировать атрибуты; защищённые коды режутся |
| `entities` | type (entity_type) | `ENTITY_TYPE_REQUIREMENT` для операторов; резерв, разделы | по праву типа |
| `attribute_values` | type (entity_type) | то же + backstop защищённых кодов, `section_access` — суперадмин | по праву типа |
| `operations` | type (operation_type) | `OPERATION_TYPE_REQUIREMENT`, строка этапа работ — `work_sheets.edit` для всех ролей, закрытые наряды — владелец | по праву типа |
| `audit_log` | **append_only** (с 21.09) | `applyPushBatch`: актор из сессии, `deleted_at` не принимается, существующая строка не перезаписывается | только добавить запись |
| `chat_messages` | row `sender_user_id` | `sync_policy_denied: chat_message_sender` | свои сообщения |
| `chat_reads` | row `user_id` | `sync_policy_denied: chat_room_member` | свои отметки |
| `chat_rooms` | row `owner_user_id` | `sync_policy_denied: chat_room_owner` | свои комнаты |
| `user_presence` | **session** | сервер штампует heartbeat сам; payload клиента не читается | ничего (строка подтверждается) |
| `notes` | row `owner_user_id` | `sync_policy_denied: note_owner` | свои заметки |
| `note_shares` | row `recipient_user_id` | `sync_policy_denied: note_share` | свои шаринги |
| `card_drafts` | row `owner_user_id` | `sync_policy_denied: card_draft_owner` | свои черновики |
| `ai_chat_requests` | row `user_id` | `applyAiChatPushPolicy` (владелец + rate-limit) | свои запросы |
| `erp_nomenclature` | permission | `parts.edit` | по праву |
| `erp_engine_assembly_bom` / `_lines` / `_brand_links` | permission | `masterdata.edit` | по праву |
| `erp_engine_instances` | permission | `engines.edit` | по праву |
| `erp_engine_inventory_lines` | permission | `operations.edit` | по праву |
| `erp_reg_stock_balance` | **server** (с 21.09) | backstop server-managed | ничего |
| `erp_reg_stock_movements` | **server** (с 21.09) | backstop server-managed | ничего |
| `warehouse_locations` | server | backstop server-managed | ничего |
| `users` | server | backstop server-managed | ничего |
| `user_section_access` | server | backstop server-managed | ничего |

## Что в ledger-двери ещё открыто

1. **Обход для не-операторских ролей** (`ledgerAuthzGuard.ts`, ветка `if (!operatorScoped)`): admin / легаси `user` / pending / employee проходят мимо requirement'ов по типу. Все backstop'ы стоят выше неё именно поэтому. Снятие обхода — вместе с B6 и прогретой офлайн-очередью парка (легаси-строки).
2. **Неизвестный тип сущности падает open** (`ENTITY_TYPE_REQUIREMENT[code] ?? open`). Таблицы с 21.09 закрыты (`?? superadmin`), типы — нет: тот же переворот, что п.1.
3. **Семь построчных проверок стоят после подписи в журнал** (класс M34): строка, отвергнутая `sync_policy_denied`, уже в `ledger_tx_index`. Их место — в `partitionLedgerInputsByAuthz`, до подписи; это отдельный шаг, потому что проверки читают существующие строки внутри транзакции применения.
