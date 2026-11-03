-- Публикация строк приказа о СИЗ в журнал синхронизации.
--
-- Зачем: миграция 0118 залила данные прямо в таблицы (INSERT ... 'synced'), минуя
-- журнал. Штамп публикатора (sync_status != 'synced') при этом не снят, и строки
-- остались позади курсора клиентов: парк норм приказа не увидел бы (GOTCHAS M179 —
-- «новая таблица контракта или разовый бэкфилл — отдельный шаг выката»).
--
-- Что делаем: переводим строки приказа в 'pending' — штатный издатель (ppeSyncPublisherService)
-- подхватит их и запишет в журнал, а клиент получит по обычному pull. Номенклатуру СИЗ
-- публикует складская REST-дверь (у неё своего издателя нет), поэтому её строки
-- публикуются отдельно: sync:restamp --tables=erp_nomenclature (см. шаг выката в PR).
--
-- Идемпотентно: переводятся только строки, ещё не опубликованные ('synced' → 'pending').

UPDATE ppe_occupation_ref
   SET sync_status = 'pending'
 WHERE sync_status = 'synced' AND deleted_at IS NULL;

UPDATE ppe_norm_line_specs
   SET sync_status = 'pending'
 WHERE sync_status = 'synced' AND deleted_at IS NULL;

UPDATE ppe_norm_sets
   SET sync_status = 'pending'
 WHERE sync_status = 'synced' AND deleted_at IS NULL;

UPDATE ppe_norm_lines
   SET sync_status = 'pending'
 WHERE sync_status = 'synced' AND deleted_at IS NULL;
