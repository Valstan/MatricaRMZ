-- Цех производственной программы — из справочника, а не свободный текст
-- (владелец 24.11.2026: «выбор цеха происходит не из базы, а это неправильно,
-- надо чтобы цех выбирался из базы, чтобы потом искать и фильтровать и статистику
-- отравлять удобнее было по цехам»).
--
-- Что за колонка:
--   - `erp_production_programs.workshop_id` — id цеха из `directory_workshops`;
--     это СВЯЗЬ, по которой ищут, фильтруют и считают статистику по цехам;
--   - `erp_production_programs.shop` остаётся СНИМКОМ имени цеха: печатная
--     форма ПП и выгрузка в Word/Excel идут по нему, и в образце там «Цех № 1».
--     Снимок нужен и потому, что переименование цеха не должно менять уже
--     подписанный план.
--
-- Nullable: у программ, заведённых до этой миграции, связи нет (NULL). Бэкфилл
-- (`production-programs:backfill-workshop`) проставляет её ТОЛЬКО при однозначном
-- совпадении со справочником; неоднозначные и несовпавшие не угадываются и
-- ждут решения владельца.
--
-- У клиента (реплика Electron и Android) та же nullability — иначе
-- checkReplicaStrictness уронит pull.
--
-- Миграция чисто АДДИТИВНАЯ: данных не трогает (связь ставит отдельный скрипт
-- с отчётом), поэтому её откат — обратное удаление колонки.

ALTER TABLE erp_production_programs
  ADD COLUMN IF NOT EXISTS workshop_id uuid;

CREATE INDEX IF NOT EXISTS erp_production_programs_workshop_idx
  ON erp_production_programs(workshop_id);

-- Ссылочная целостность: программа не может ссылаться на несуществующий цех.
-- Цехи удаляются МЯГКО (deleted_at), поэтому ограничение не блокирует работу
-- справочника. IF NOT EXISTS — миграция идемпотентна.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'erp_production_programs_workshop_fk'
  ) THEN
    ALTER TABLE erp_production_programs
      ADD CONSTRAINT erp_production_programs_workshop_fk
      FOREIGN KEY (workshop_id) REFERENCES directory_workshops(id);
  END IF;
END $$;
