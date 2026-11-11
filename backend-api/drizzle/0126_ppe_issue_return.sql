-- Возврат СИЗ: «получил обратно» — состояние строки выдачи.
--
-- Владелец (09.11.2026, через brain): «если человек отработал меньше года или
-- уволился, спецодежда подлежит возврату — кладовщик ставит отметку „получил
-- обратно“». Живёт в бланке выдачи и в ведомости.
--
-- Это НЕ переименование «Даты изменения профессии» в личной карточке — другое
-- поле и другое событие. Отдельная таблица не заводится: возврат — состояние
-- существующей строки выдачи (ppe_issue_entries), а новая таблица была бы лишним
-- контрактом синхронизации.
--
-- wear_percent — процент износа: владелец просил его «там же» (промт 21).
-- Правило пересчёта не выводим без карточки СИЗ с оборотной стороной, но место
-- под значение заводим сразу (промт 26: «место под него заранее»).
--
-- Ведёт серверная дверь (ppeService: markPpeIssueReturned / undoPpeIssueReturn,
-- REST /ppe/issue-entries/:id/return), клиент читает реплику (server-write /
-- pull-only — владение таблиц в shared/domain/ledgerAuthz).

ALTER TABLE ppe_issue_entries
  ADD COLUMN IF NOT EXISTS returned_at bigint;

ALTER TABLE ppe_issue_entries
  ADD COLUMN IF NOT EXISTS returned_by text;

ALTER TABLE ppe_issue_entries
  ADD COLUMN IF NOT EXISTS wear_percent integer;
