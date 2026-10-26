# Серверный pg_trgm typeahead (поиск #035 Ф3) 🗓 since:2026-06-13

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг»

Отложено как преждевременное (замер 2026-06-13: `erp_nomenclature` 637 строк, Seq Scan 6.6мс). **Триггер:** каталог до ~10–20k+ строк ИЛИ серверный поиск по большой таблице (движения/документы) → GIN + restructure предиката (drop `COALESCE`, функц-индекс, EXPLAIN BitmapOr). До тех пор клиентский tiered-matcher покрывает. Поверхность: `nomenclatureSearchCondition` (`warehouseService.ts:1291`). Опц.-малое: `matchesQueryInRecord` пер-строчно зовёт `prepareLookupOptions` — для очень больших списков переключить на memoized `prepareRecordSearch` (`ui/utils/search.ts`).
