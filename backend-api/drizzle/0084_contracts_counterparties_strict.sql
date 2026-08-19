-- B2 (план matrica-v4-kickoff, трек B этап 2): контрагенты и договоры — строгие
-- таблицы с СОХРАНЕНИЕМ EAV-id (brain #162: мигратор обязан сохранять id источника).
--
-- Обе таблицы существовали как пустой каркас /erp-прототипа (0 строк на проде,
-- прежняя форма: code/name/attrs_json-свалка) — пересоздаём в каноничной форме:
-- атрибуты, жившие в EAV соглашением, становятся колонками. Источник правды пока
-- остаётся в EAV (клиенты пишут офлайн через синк) — строгие таблицы держатся
-- полными и свежими ТРИГГЕРАМИ (приём 0052/0083: одна точка на все пути записи).
-- Cutover CRUD на строгие таблицы — следующий шаг этапа, после релиза зеркала.
--
-- Унификация id-пространства договоров происходит автоматически: erp_engine_instances
-- .contract_id ссылался на вечно пустую erp_contracts, теперь та id-тождественна EAV.
--
-- Платежи (contract_payments) переносятся ПОКА единым JSON (payments_json):
-- клиентский read-modify-write мутирует весь атрибут офлайн; реляционная модель
-- платежей возможна только вместе с cutover CRUD.

-- 1) Снять inbound-FK со старых каркасов и пересоздать таблицы.
ALTER TABLE erp_engine_instances DROP CONSTRAINT IF EXISTS "erp_engine_instances_contract_id_erp_contracts_id_fk";
--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname, c.conrelid::regclass::text AS tbl
      FROM pg_constraint c
     WHERE c.contype = 'f'
       AND c.confrelid IN ('erp_contracts'::regclass, 'erp_counterparties'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END;
$$;
--> statement-breakpoint
DROP TABLE IF EXISTS erp_contracts;
--> statement-breakpoint
DROP TABLE IF EXISTS erp_counterparties;
--> statement-breakpoint

CREATE TABLE erp_counterparties (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  short_name text,
  inn text,
  kpp text,
  address text,
  email text,
  phone text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint
);
--> statement-breakpoint
CREATE INDEX erp_counterparties_name_idx ON erp_counterparties (name);
--> statement-breakpoint

-- number/internal_number намеренно БЕЗ unique: в живых данных есть исторические
-- дубли («три договора 20/ГОЗ-25», открытый вопрос владельца); дубли новых блокирует
-- гейт #612. Инвариант станет констрейнтом после разбора дублей.
CREATE TABLE erp_contracts (
  id uuid PRIMARY KEY,
  number text,
  internal_number text,
  goz_name text,
  goz_igk text,
  goz_separate_account_number text,
  goz_separate_account_bank text,
  goz_separate_account text,
  signed_at bigint,
  due_at bigint,
  customer_id uuid REFERENCES erp_counterparties(id),
  comment text,
  sections_json text,
  execution_parts_json text,
  payments_json text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint
);
--> statement-breakpoint
CREATE INDEX erp_contracts_number_idx ON erp_contracts (number);
--> statement-breakpoint
CREATE INDEX erp_contracts_internal_number_idx ON erp_contracts (internal_number);
--> statement-breakpoint
CREATE INDEX erp_contracts_customer_idx ON erp_contracts (customer_id);
--> statement-breakpoint

-- 2) Помощники чтения EAV-атрибута (устойчивы к сырым не-JSON значениям).
CREATE OR REPLACE FUNCTION eav_attr_text(p_entity uuid, p_code text)
RETURNS text AS $$
DECLARE v_raw text; v_out text;
BEGIN
  SELECT av.value_json INTO v_raw
    FROM attribute_values av
    JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.code = p_code
   WHERE av.entity_id = p_entity AND av.deleted_at IS NULL
   LIMIT 1;
  IF v_raw IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v_out := v_raw::jsonb #>> '{}';
  EXCEPTION WHEN others THEN
    v_out := v_raw;
  END;
  RETURN nullif(v_out, '');
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION eav_attr_ms(p_entity uuid, p_code text)
RETURNS bigint AS $$
DECLARE v_txt text := eav_attr_text(p_entity, p_code);
BEGIN
  IF v_txt IS NULL THEN RETURN NULL; END IF;
  BEGIN
    RETURN round(v_txt::numeric)::bigint;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION eav_attr_uuid(p_entity uuid, p_code text)
RETURNS uuid AS $$
DECLARE v_txt text := eav_attr_text(p_entity, p_code);
BEGIN
  IF v_txt IS NULL THEN RETURN NULL; END IF;
  BEGIN
    RETURN v_txt::uuid;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

-- 3) Rebuild-функции: пересобирают строгую строку из живых EAV-атрибутов целиком.
-- Снятие атрибута корректно очищает колонку — пере-чтение, а не точечный патч.
CREATE OR REPLACE FUNCTION rebuild_erp_counterparty(p_id uuid)
RETURNS void AS $$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_deleted bigint;
  v_found boolean;
BEGIN
  SELECT true, e.deleted_at INTO v_found, v_deleted
    FROM entities e
    JOIN entity_types t ON t.id = e.type_id AND t.code = 'customer'
   WHERE e.id = p_id;
  IF v_found IS DISTINCT FROM true THEN RETURN; END IF;
  INSERT INTO erp_counterparties (id, name, short_name, inn, kpp, address, email, phone, created_at, updated_at, deleted_at)
  VALUES (
    p_id,
    coalesce(eav_attr_text(p_id, 'name'), 'Без названия'),
    eav_attr_text(p_id, 'short_name'),
    eav_attr_text(p_id, 'inn'),
    eav_attr_text(p_id, 'kpp'),
    eav_attr_text(p_id, 'address'),
    eav_attr_text(p_id, 'email'),
    eav_attr_text(p_id, 'phone'),
    v_ms, v_ms, v_deleted
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    short_name = EXCLUDED.short_name,
    inn = EXCLUDED.inn,
    kpp = EXCLUDED.kpp,
    address = EXCLUDED.address,
    email = EXCLUDED.email,
    phone = EXCLUDED.phone,
    updated_at = EXCLUDED.updated_at,
    deleted_at = EXCLUDED.deleted_at;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rebuild_erp_contract(p_id uuid)
RETURNS void AS $$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_deleted bigint;
  v_found boolean;
  v_customer uuid;
  v_sections text := eav_attr_text(p_id, 'contract_sections');
BEGIN
  SELECT true, e.deleted_at INTO v_found, v_deleted
    FROM entities e
    JOIN entity_types t ON t.id = e.type_id AND t.code = 'contract'
   WHERE e.id = p_id;
  IF v_found IS DISTINCT FROM true THEN RETURN; END IF;

  -- Заказчик: атрибут customer_id, фолбэк — contract_sections.primary.customerId.
  v_customer := eav_attr_uuid(p_id, 'customer_id');
  IF v_customer IS NULL AND v_sections IS NOT NULL THEN
    BEGIN
      v_customer := nullif(v_sections::jsonb -> 'primary' ->> 'customerId', '')::uuid;
    EXCEPTION WHEN others THEN
      v_customer := NULL;
    END;
  END IF;
  -- FK-страховка: битая ссылка (заказчик вне зеркала) не должна валить запись.
  IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM erp_counterparties c WHERE c.id = v_customer) THEN
    v_customer := NULL;
  END IF;

  INSERT INTO erp_contracts (
    id, number, internal_number, goz_name, goz_igk,
    goz_separate_account_number, goz_separate_account_bank, goz_separate_account,
    signed_at, due_at, customer_id, comment,
    sections_json, execution_parts_json, payments_json,
    created_at, updated_at, deleted_at
  )
  VALUES (
    p_id,
    eav_attr_text(p_id, 'number'),
    eav_attr_text(p_id, 'internal_number'),
    eav_attr_text(p_id, 'goz_name'),
    eav_attr_text(p_id, 'goz_igk'),
    eav_attr_text(p_id, 'goz_separate_account_number'),
    eav_attr_text(p_id, 'goz_separate_account_bank'),
    eav_attr_text(p_id, 'goz_separate_account'),
    eav_attr_ms(p_id, 'date'),
    eav_attr_ms(p_id, 'due_date'),
    v_customer,
    eav_attr_text(p_id, 'comment'),
    v_sections,
    eav_attr_text(p_id, 'contract_execution_parts'),
    eav_attr_text(p_id, 'contract_payments'),
    v_ms, v_ms, v_deleted
  )
  ON CONFLICT (id) DO UPDATE SET
    number = EXCLUDED.number,
    internal_number = EXCLUDED.internal_number,
    goz_name = EXCLUDED.goz_name,
    goz_igk = EXCLUDED.goz_igk,
    goz_separate_account_number = EXCLUDED.goz_separate_account_number,
    goz_separate_account_bank = EXCLUDED.goz_separate_account_bank,
    goz_separate_account = EXCLUDED.goz_separate_account,
    signed_at = EXCLUDED.signed_at,
    due_at = EXCLUDED.due_at,
    customer_id = EXCLUDED.customer_id,
    comment = EXCLUDED.comment,
    sections_json = EXCLUDED.sections_json,
    execution_parts_json = EXCLUDED.execution_parts_json,
    payments_json = EXCLUDED.payments_json,
    updated_at = EXCLUDED.updated_at,
    deleted_at = EXCLUDED.deleted_at;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- 4) Триггеры: entities (создание/soft-delete/восстановление) + attribute_values
-- (любая правка атрибута, включая снятие — rebuild перечитает живое состояние).
CREATE OR REPLACE FUNCTION mirror_customer_contract_entity()
RETURNS TRIGGER AS $$
DECLARE v_type text;
BEGIN
  SELECT t.code INTO v_type FROM entity_types t WHERE t.id = NEW.type_id;
  IF v_type = 'customer' THEN
    PERFORM rebuild_erp_counterparty(NEW.id);
  ELSIF v_type = 'contract' THEN
    PERFORM rebuild_erp_contract(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_mirror_customer_contract_entity ON entities;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_customer_contract_entity
AFTER INSERT OR UPDATE OF deleted_at ON entities
FOR EACH ROW EXECUTE FUNCTION mirror_customer_contract_entity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION mirror_customer_contract_attr()
RETURNS TRIGGER AS $$
DECLARE v_type text;
BEGIN
  SELECT t.code INTO v_type
    FROM attribute_defs ad
    JOIN entity_types t ON t.id = ad.entity_type_id
   WHERE ad.id = NEW.attribute_def_id;
  IF v_type = 'customer' THEN
    PERFORM rebuild_erp_counterparty(NEW.entity_id);
  ELSIF v_type = 'contract' THEN
    PERFORM rebuild_erp_contract(NEW.entity_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_mirror_customer_contract_attr ON attribute_values;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_customer_contract_attr
AFTER INSERT OR UPDATE OF value_json, deleted_at ON attribute_values
FOR EACH ROW EXECUTE FUNCTION mirror_customer_contract_attr();
--> statement-breakpoint

-- 5) Backfill: контрагенты раньше договоров (FK), включая soft-deleted.
SELECT rebuild_erp_counterparty(e.id)
  FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code = 'customer';
--> statement-breakpoint
SELECT rebuild_erp_contract(e.id)
  FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code = 'contract';
--> statement-breakpoint

-- 6) Вернуть inbound-FK. Орфаны движений/экземпляров (ссылки вне зеркала) — в NULL,
-- FK обязан пройти; таких на проде быть не должно (обе таблицы-хозяева пусты/молоды).
UPDATE erp_reg_stock_movements m SET counterparty_id = NULL
 WHERE m.counterparty_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM erp_counterparties c WHERE c.id = m.counterparty_id);
--> statement-breakpoint
UPDATE erp_engine_instances i SET contract_id = NULL
 WHERE i.contract_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM erp_contracts c WHERE c.id = i.contract_id);
--> statement-breakpoint
ALTER TABLE erp_reg_stock_movements
  ADD CONSTRAINT "erp_reg_stock_movements_counterparty_fk"
  FOREIGN KEY (counterparty_id) REFERENCES erp_counterparties(id);
--> statement-breakpoint
ALTER TABLE erp_engine_instances
  ADD CONSTRAINT "erp_engine_instances_contract_fk"
  FOREIGN KEY (contract_id) REFERENCES erp_contracts(id);
