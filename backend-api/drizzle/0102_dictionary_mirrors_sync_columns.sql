-- S1 плана sync-mirror-dictionaries-2026-10: три словарных зеркала готовятся к pull-only
-- репликации по образцу warehouse_locations (0093).
--
-- erp_counterparties + erp_contracts (зеркала 0084) и directory_engine_brands (зеркало 0083)
-- получают те же колонки, что любая синхронизируемая таблица: `sync_status` / `last_server_seq`.
-- Номер журнала проставит публикатор через writeSyncChanges (S3); инкрементальный pull
-- отбирает `last_server_seq > since`, а `NULL > n` в SQL не TRUE — поэтому существующие
-- строки помечаются к публикации прямо здесь.
--
-- Rebuild-функции переписаны с правилом «pending только на реальном изменении»
-- (приём users R3, 0088 «ШТОРМ»): триггер дёргается на ЛЮБУЮ правку атрибута сущности,
-- и без WHERE-гарда правка телефона контрагента рассылала бы его строку всему парку.
-- Попутно уходит холостой бамп updated_at на каждое срабатывание — как в 0088.
-- Семантика самих зеркал не меняется: EAV остаётся источником правды, триггеры те же.
ALTER TABLE erp_counterparties ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
--> statement-breakpoint
ALTER TABLE erp_counterparties ADD COLUMN IF NOT EXISTS last_server_seq bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_counterparties_seq_idx ON erp_counterparties (last_server_seq);
--> statement-breakpoint
ALTER TABLE erp_contracts ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
--> statement-breakpoint
ALTER TABLE erp_contracts ADD COLUMN IF NOT EXISTS last_server_seq bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_contracts_seq_idx ON erp_contracts (last_server_seq);
--> statement-breakpoint
ALTER TABLE directory_engine_brands ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'synced';
--> statement-breakpoint
ALTER TABLE directory_engine_brands ADD COLUMN IF NOT EXISTS last_server_seq bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS directory_engine_brands_seq_idx ON directory_engine_brands (last_server_seq);
--> statement-breakpoint
UPDATE erp_counterparties SET sync_status = 'pending';
--> statement-breakpoint
UPDATE erp_contracts SET sync_status = 'pending';
--> statement-breakpoint
UPDATE directory_engine_brands SET sync_status = 'pending';
--> statement-breakpoint

-- rebuild_erp_counterparty: тело из 0084 + sync_status='pending' на вставке и на
-- фактическом изменении (WHERE-гард по всем зеркалируемым колонкам).
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
  INSERT INTO erp_counterparties (id, name, short_name, inn, kpp, address, email, phone, created_at, updated_at, deleted_at, sync_status)
  VALUES (
    p_id,
    coalesce(eav_attr_text(p_id, 'name'), 'Без названия'),
    eav_attr_text(p_id, 'short_name'),
    eav_attr_text(p_id, 'inn'),
    eav_attr_text(p_id, 'kpp'),
    eav_attr_text(p_id, 'address'),
    eav_attr_text(p_id, 'email'),
    eav_attr_text(p_id, 'phone'),
    v_ms, v_ms, v_deleted, 'pending'
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
    deleted_at = EXCLUDED.deleted_at,
    sync_status = 'pending'
  WHERE (
      erp_counterparties.name, erp_counterparties.short_name, erp_counterparties.inn,
      erp_counterparties.kpp, erp_counterparties.address, erp_counterparties.email,
      erp_counterparties.phone, erp_counterparties.deleted_at
    ) IS DISTINCT FROM (
      EXCLUDED.name, EXCLUDED.short_name, EXCLUDED.inn,
      EXCLUDED.kpp, EXCLUDED.address, EXCLUDED.email,
      EXCLUDED.phone, EXCLUDED.deleted_at
    );
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- rebuild_erp_contract: тело из 0084 + тот же pending-гард.
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
    created_at, updated_at, deleted_at, sync_status
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
    v_ms, v_ms, v_deleted, 'pending'
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
    deleted_at = EXCLUDED.deleted_at,
    sync_status = 'pending'
  WHERE (
      erp_contracts.number, erp_contracts.internal_number, erp_contracts.goz_name,
      erp_contracts.goz_igk, erp_contracts.goz_separate_account_number,
      erp_contracts.goz_separate_account_bank, erp_contracts.goz_separate_account,
      erp_contracts.signed_at, erp_contracts.due_at, erp_contracts.customer_id,
      erp_contracts.comment, erp_contracts.sections_json,
      erp_contracts.execution_parts_json, erp_contracts.payments_json,
      erp_contracts.deleted_at
    ) IS DISTINCT FROM (
      EXCLUDED.number, EXCLUDED.internal_number, EXCLUDED.goz_name,
      EXCLUDED.goz_igk, EXCLUDED.goz_separate_account_number,
      EXCLUDED.goz_separate_account_bank, EXCLUDED.goz_separate_account,
      EXCLUDED.signed_at, EXCLUDED.due_at, EXCLUDED.customer_id,
      EXCLUDED.comment, EXCLUDED.sections_json,
      EXCLUDED.execution_parts_json, EXCLUDED.payments_json,
      EXCLUDED.deleted_at
    );
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- mirror_engine_brand_entity: тело из 0083 + pending-гард по (name, deleted_at).
CREATE OR REPLACE FUNCTION mirror_engine_brand_entity()
RETURNS TRIGGER AS $$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entity_types t WHERE t.id = NEW.type_id AND t.code = 'engine_brand'
  ) THEN
    RETURN NEW;
  END IF;
  SELECT nullif(trim(both '"' from coalesce(av.value_json, '')), '') INTO v_name
    FROM attribute_values av
    JOIN attribute_defs ad ON ad.id = av.attribute_def_id AND ad.code = 'name'
   WHERE av.entity_id = NEW.id AND av.deleted_at IS NULL
   LIMIT 1;
  INSERT INTO directory_engine_brands (id, name, is_active, created_at, updated_at, deleted_at, sync_status)
  VALUES (NEW.id, coalesce(v_name, 'Без названия'), true, v_ms, v_ms, NEW.deleted_at, 'pending')
  ON CONFLICT (id) DO UPDATE
     SET deleted_at = EXCLUDED.deleted_at,
         name = coalesce(v_name, directory_engine_brands.name),
         updated_at = EXCLUDED.updated_at,
         sync_status = 'pending'
   WHERE (directory_engine_brands.name, directory_engine_brands.deleted_at)
     IS DISTINCT FROM (coalesce(v_name, directory_engine_brands.name), EXCLUDED.deleted_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- mirror_engine_brand_name_attr: тело из 0083 + pending-гард по name.
CREATE OR REPLACE FUNCTION mirror_engine_brand_name_attr()
RETURNS TRIGGER AS $$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_name text;
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW; -- снятое имя не затираем: у зеркала останется последнее известное
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM attribute_defs ad
      JOIN entity_types t ON t.id = ad.entity_type_id AND t.code = 'engine_brand'
     WHERE ad.id = NEW.attribute_def_id AND ad.code = 'name'
  ) THEN
    RETURN NEW;
  END IF;
  v_name := nullif(trim(both '"' from coalesce(NEW.value_json, '')), '');
  IF v_name IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO directory_engine_brands (id, name, is_active, created_at, updated_at, sync_status)
  VALUES (NEW.entity_id, v_name, true, v_ms, v_ms, 'pending')
  ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name, updated_at = EXCLUDED.updated_at, sync_status = 'pending'
   WHERE directory_engine_brands.name IS DISTINCT FROM EXCLUDED.name;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
