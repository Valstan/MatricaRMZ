# Ретенция журнала `ledger_tx_index` (831 МБ на 06.09) 🗓 since:2026-06-12

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг»

> С 2026-09 цепочки блоков нет (план `ledger-journal-in-pg`); «история» = `ledger_tx_index` в PG. Ниже — прежняя запись про changelog-walk, она про ту же таблицу; ретенция — отдельное решение после E3 плана `engine-inventory-lines` (строчные записи вместо 48–255 КБ листов).

changelog-walk отдаёт мёртвые версии строк (доля растёт с историей). **Триггер:** wall первой страницы changelog-walk у живых клиентов начнёт расти (видно по `pull attempt=ok durMs`). Предусловие (атомарная запись + advisory-lock LedgerStore) — снято. Гнать in-process job'ом на primary под `withLock`. Файл: `backend-api/src/services/ledger.ts`.
