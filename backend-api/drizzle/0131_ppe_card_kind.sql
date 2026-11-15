-- Вид СИЗ: карточка спецодежды и карточка мыла (промты КАРМАНА #21 и #26).
--
-- Владелец: «набор норм должен заводиться прямо из карточки СИЗ, в том числе набор на
-- мыло, которого в приказе сейчас нет» и «нужна отдельная карточка на мыло: выдаётся
-- отдельно от карточки по спецодежде, по своей норме».
--
-- Значит, у набора норм и у карточки выдачи появляется ВИД ('workwear' | 'soap'):
--   - наборы разных видов не смешиваются (у мыла своя норма);
--   - открытая карточка теперь одна НА ВИД, а не одна на сотрудника: у кладовщика
--     карточка по спецодежде и карточка по мылу — разные следы выдачи.
--
-- Колонки строгих таблиц, а не EAV (EAV заморожен, AGENTS.md §EAV). NOT NULL с
-- дефолтом 'workwear': все прежние наборы и карточки — спецодежда, переносить их
-- вручную не нужно. У клиента (реплика) та же nullability, иначе checkReplicaStrictness
-- уронит pull.

ALTER TABLE ppe_norm_sets
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'workwear';

ALTER TABLE ppe_issue_cards
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'workwear';

-- Открытая карточка — одна на вид. Прежний уникальный индекс (employee_id) запрещал
-- вторую открытую карточку вообще; теперь запрет по паре (employee_id, kind).
DROP INDEX IF EXISTS ppe_issue_cards_employee_open_uq;

CREATE UNIQUE INDEX IF NOT EXISTS ppe_issue_cards_employee_kind_open_uq
  ON ppe_issue_cards (employee_id, kind)
  WHERE closed_at IS NULL AND deleted_at IS NULL;
