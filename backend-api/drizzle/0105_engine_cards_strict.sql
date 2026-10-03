-- B4 трека B, шаг E1 (план engine-cards-strict-2026-10): карточка двигателя
-- уходит из EAV в строгую таблицу erp_engine_cards. id = entities.id (канон без
-- FK на entities, как users/contract-CT). Sync-колонки сразу: вход в контракт —
-- тем же релизом (прецедент #720/#721), публикатор словарей разберёт pending.
-- Писатели и читатели не тронуты (зеркало триггерное, EAV остаётся источником).

CREATE TABLE IF NOT EXISTS erp_engine_cards (
  id uuid PRIMARY KEY,
  engine_number text,
  engine_internal_number text,
  engine_internal_number_year bigint,
  engine_brand_id uuid,
  engine_brand text,
  arrival_date bigint,
  customer_id uuid,
  contract_id uuid,
  contract_section_number text,
  workshop_id uuid,
  status_rework_sent boolean NOT NULL DEFAULT false,
  status_rework_sent_date bigint,
  status_scrap_confirmed boolean NOT NULL DEFAULT false,
  status_scrap_confirmed_date bigint,
  status_repair_started boolean NOT NULL DEFAULT false,
  status_repair_started_date bigint,
  status_repaired boolean NOT NULL DEFAULT false,
  status_repaired_date bigint,
  status_customer_sent boolean NOT NULL DEFAULT false,
  status_customer_sent_date bigint,
  status_customer_accepted boolean NOT NULL DEFAULT false,
  status_customer_accepted_date bigint,
  status_storage_received boolean NOT NULL DEFAULT false,
  status_storage_received_date bigint,
  status_rejected boolean NOT NULL DEFAULT false,
  status_rejected_date bigint,
  scrap_reason text,
  reclamation_flag boolean NOT NULL DEFAULT false,
  reclamation_accepted_date bigint,
  reclamation_customer_reason text,
  reclamation_actual_defect text,
  reclamation_defect_nature text,
  reclamation_act_number text,
  reclamation_verdict_date bigint,
  reclamation_shipped_date bigint,
  reclamation_comment text,
  reclamation_verdict text,
  reclamation_repair_status text,
  repeat_arrival_flag boolean NOT NULL DEFAULT false,
  number_collision_flag boolean NOT NULL DEFAULT false,
  previous_arrival_id uuid,
  merged_into uuid,
  arrival_invoice text,
  shipment_invoice text,
  engine_note text,
  docs_state text,
  docs_aspvr_contractor_date bigint,
  docs_vp_sent_date bigint,
  docs_vp_returned_date bigint,
  docs_aspvr_customer_scan_date bigint,
  docs_aspvr_customer_original_date bigint,
  docs_track_or_act text,
  docs_aspvr_signed_customer_date bigint,
  docs_aspvr_customer_received boolean NOT NULL DEFAULT false,
  docs_return_scan_date bigint,
  docs_return_original_date bigint,
  docs_note text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_cards_number_idx ON erp_engine_cards (engine_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_cards_contract_idx ON erp_engine_cards (contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_engine_cards_seq_idx ON erp_engine_cards (last_server_seq);
--> statement-breakpoint
-- Флаг EAV (isEavFlagSet): boolean true, number 1, строки 'true'/'1'.
-- eav_attr_text уже отдаёт jsonb-нормализованный текст ('true' / '1').
CREATE OR REPLACE FUNCTION eav_attr_bool(p_entity uuid, p_code text)
RETURNS boolean AS $$
DECLARE v_txt text := eav_attr_text(p_entity, p_code);
BEGIN
  IF v_txt IS NULL THEN RETURN false; END IF;
  RETURN lower(btrim(v_txt)) IN ('true', '1');
END;
$$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint
-- Полная пересборка строки из живых EAV-атрибутов (снятие атрибута чистит
-- колонку). Ссылки без FK и с защитой от мусора (битый uuid → NULL, как в 0084):
-- legacy-данные с висячими ссылками не должны ронять зеркало.
-- pending — только на реальном изменении (WHERE-гард, приём users R3 «ШТОРМ»).
CREATE OR REPLACE FUNCTION rebuild_erp_engine_card(p_id uuid)
RETURNS void AS $$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_deleted bigint;
  v_found boolean;
BEGIN
  SELECT true, e.deleted_at INTO v_found, v_deleted
    FROM entities e
    JOIN entity_types t ON t.id = e.type_id AND t.code = 'engine'
   WHERE e.id = p_id;
  IF v_found IS DISTINCT FROM true THEN RETURN; END IF;

  INSERT INTO erp_engine_cards (
    id, engine_number, engine_internal_number, engine_internal_number_year,
    engine_brand_id, engine_brand, arrival_date,
    customer_id, contract_id, contract_section_number, workshop_id,
    status_rework_sent, status_rework_sent_date,
    status_scrap_confirmed, status_scrap_confirmed_date,
    status_repair_started, status_repair_started_date,
    status_repaired, status_repaired_date,
    status_customer_sent, status_customer_sent_date,
    status_customer_accepted, status_customer_accepted_date,
    status_storage_received, status_storage_received_date,
    status_rejected, status_rejected_date,
    scrap_reason,
    reclamation_flag, reclamation_accepted_date, reclamation_customer_reason,
    reclamation_actual_defect, reclamation_defect_nature, reclamation_act_number,
    reclamation_verdict_date, reclamation_shipped_date, reclamation_comment,
    reclamation_verdict, reclamation_repair_status,
    repeat_arrival_flag, number_collision_flag, previous_arrival_id, merged_into,
    arrival_invoice, shipment_invoice, engine_note,
    docs_state, docs_aspvr_contractor_date, docs_vp_sent_date, docs_vp_returned_date,
    docs_aspvr_customer_scan_date, docs_aspvr_customer_original_date, docs_track_or_act,
    docs_aspvr_signed_customer_date, docs_aspvr_customer_received,
    docs_return_scan_date, docs_return_original_date, docs_note,
    created_at, updated_at, deleted_at, sync_status
  )
  VALUES (
    p_id,
    eav_attr_text(p_id, 'engine_number'),
    eav_attr_text(p_id, 'engine_internal_number'),
    eav_attr_ms(p_id, 'engine_internal_number_year'),
    eav_attr_uuid(p_id, 'engine_brand_id'),
    eav_attr_text(p_id, 'engine_brand'),
    eav_attr_ms(p_id, 'arrival_date'),
    eav_attr_uuid(p_id, 'customer_id'),
    eav_attr_uuid(p_id, 'contract_id'),
    eav_attr_text(p_id, 'contract_section_number'),
    eav_attr_uuid(p_id, 'workshop_id'),
    eav_attr_bool(p_id, 'status_rework_sent'),
    eav_attr_ms(p_id, 'status_rework_sent_date'),
    eav_attr_bool(p_id, 'status_scrap_confirmed'),
    eav_attr_ms(p_id, 'status_scrap_confirmed_date'),
    eav_attr_bool(p_id, 'status_repair_started'),
    eav_attr_ms(p_id, 'status_repair_started_date'),
    eav_attr_bool(p_id, 'status_repaired'),
    eav_attr_ms(p_id, 'status_repaired_date'),
    eav_attr_bool(p_id, 'status_customer_sent'),
    eav_attr_ms(p_id, 'status_customer_sent_date'),
    eav_attr_bool(p_id, 'status_customer_accepted'),
    eav_attr_ms(p_id, 'status_customer_accepted_date'),
    eav_attr_bool(p_id, 'status_storage_received'),
    eav_attr_ms(p_id, 'status_storage_received_date'),
    eav_attr_bool(p_id, 'status_rejected'),
    eav_attr_ms(p_id, 'status_rejected_date'),
    eav_attr_text(p_id, 'scrap_reason'),
    eav_attr_bool(p_id, 'reclamation_flag'),
    eav_attr_ms(p_id, 'reclamation_accepted_date'),
    eav_attr_text(p_id, 'reclamation_customer_reason'),
    eav_attr_text(p_id, 'reclamation_actual_defect'),
    eav_attr_text(p_id, 'reclamation_defect_nature'),
    eav_attr_text(p_id, 'reclamation_act_number'),
    eav_attr_ms(p_id, 'reclamation_verdict_date'),
    eav_attr_ms(p_id, 'reclamation_shipped_date'),
    eav_attr_text(p_id, 'reclamation_comment'),
    eav_attr_text(p_id, 'reclamation_verdict'),
    eav_attr_text(p_id, 'reclamation_repair_status'),
    eav_attr_bool(p_id, 'repeat_arrival_flag'),
    eav_attr_bool(p_id, 'number_collision_flag'),
    eav_attr_uuid(p_id, 'previous_arrival_id'),
    eav_attr_uuid(p_id, 'merged_into'),
    eav_attr_text(p_id, 'arrival_invoice'),
    eav_attr_text(p_id, 'shipment_invoice'),
    eav_attr_text(p_id, 'engine_note'),
    eav_attr_text(p_id, 'docs_state'),
    eav_attr_ms(p_id, 'docs_aspvr_contractor_date'),
    eav_attr_ms(p_id, 'docs_vp_sent_date'),
    eav_attr_ms(p_id, 'docs_vp_returned_date'),
    eav_attr_ms(p_id, 'docs_aspvr_customer_scan_date'),
    eav_attr_ms(p_id, 'docs_aspvr_customer_original_date'),
    eav_attr_text(p_id, 'docs_track_or_act'),
    eav_attr_ms(p_id, 'docs_aspvr_signed_customer_date'),
    eav_attr_bool(p_id, 'docs_aspvr_customer_received'),
    eav_attr_ms(p_id, 'docs_return_scan_date'),
    eav_attr_ms(p_id, 'docs_return_original_date'),
    eav_attr_text(p_id, 'docs_note'),
    v_ms, v_ms, v_deleted, 'pending'
  )
  ON CONFLICT (id) DO UPDATE SET
    engine_number = EXCLUDED.engine_number,
    engine_internal_number = EXCLUDED.engine_internal_number,
    engine_internal_number_year = EXCLUDED.engine_internal_number_year,
    engine_brand_id = EXCLUDED.engine_brand_id,
    engine_brand = EXCLUDED.engine_brand,
    arrival_date = EXCLUDED.arrival_date,
    customer_id = EXCLUDED.customer_id,
    contract_id = EXCLUDED.contract_id,
    contract_section_number = EXCLUDED.contract_section_number,
    workshop_id = EXCLUDED.workshop_id,
    status_rework_sent = EXCLUDED.status_rework_sent,
    status_rework_sent_date = EXCLUDED.status_rework_sent_date,
    status_scrap_confirmed = EXCLUDED.status_scrap_confirmed,
    status_scrap_confirmed_date = EXCLUDED.status_scrap_confirmed_date,
    status_repair_started = EXCLUDED.status_repair_started,
    status_repair_started_date = EXCLUDED.status_repair_started_date,
    status_repaired = EXCLUDED.status_repaired,
    status_repaired_date = EXCLUDED.status_repaired_date,
    status_customer_sent = EXCLUDED.status_customer_sent,
    status_customer_sent_date = EXCLUDED.status_customer_sent_date,
    status_customer_accepted = EXCLUDED.status_customer_accepted,
    status_customer_accepted_date = EXCLUDED.status_customer_accepted_date,
    status_storage_received = EXCLUDED.status_storage_received,
    status_storage_received_date = EXCLUDED.status_storage_received_date,
    status_rejected = EXCLUDED.status_rejected,
    status_rejected_date = EXCLUDED.status_rejected_date,
    scrap_reason = EXCLUDED.scrap_reason,
    reclamation_flag = EXCLUDED.reclamation_flag,
    reclamation_accepted_date = EXCLUDED.reclamation_accepted_date,
    reclamation_customer_reason = EXCLUDED.reclamation_customer_reason,
    reclamation_actual_defect = EXCLUDED.reclamation_actual_defect,
    reclamation_defect_nature = EXCLUDED.reclamation_defect_nature,
    reclamation_act_number = EXCLUDED.reclamation_act_number,
    reclamation_verdict_date = EXCLUDED.reclamation_verdict_date,
    reclamation_shipped_date = EXCLUDED.reclamation_shipped_date,
    reclamation_comment = EXCLUDED.reclamation_comment,
    reclamation_verdict = EXCLUDED.reclamation_verdict,
    reclamation_repair_status = EXCLUDED.reclamation_repair_status,
    repeat_arrival_flag = EXCLUDED.repeat_arrival_flag,
    number_collision_flag = EXCLUDED.number_collision_flag,
    previous_arrival_id = EXCLUDED.previous_arrival_id,
    merged_into = EXCLUDED.merged_into,
    arrival_invoice = EXCLUDED.arrival_invoice,
    shipment_invoice = EXCLUDED.shipment_invoice,
    engine_note = EXCLUDED.engine_note,
    docs_state = EXCLUDED.docs_state,
    docs_aspvr_contractor_date = EXCLUDED.docs_aspvr_contractor_date,
    docs_vp_sent_date = EXCLUDED.docs_vp_sent_date,
    docs_vp_returned_date = EXCLUDED.docs_vp_returned_date,
    docs_aspvr_customer_scan_date = EXCLUDED.docs_aspvr_customer_scan_date,
    docs_aspvr_customer_original_date = EXCLUDED.docs_aspvr_customer_original_date,
    docs_track_or_act = EXCLUDED.docs_track_or_act,
    docs_aspvr_signed_customer_date = EXCLUDED.docs_aspvr_signed_customer_date,
    docs_aspvr_customer_received = EXCLUDED.docs_aspvr_customer_received,
    docs_return_scan_date = EXCLUDED.docs_return_scan_date,
    docs_return_original_date = EXCLUDED.docs_return_original_date,
    docs_note = EXCLUDED.docs_note,
    updated_at = EXCLUDED.updated_at,
    deleted_at = EXCLUDED.deleted_at,
    sync_status = 'pending'
  WHERE (
      erp_engine_cards.engine_number, erp_engine_cards.engine_internal_number,
      erp_engine_cards.engine_internal_number_year, erp_engine_cards.engine_brand_id,
      erp_engine_cards.engine_brand, erp_engine_cards.arrival_date,
      erp_engine_cards.customer_id, erp_engine_cards.contract_id,
      erp_engine_cards.contract_section_number, erp_engine_cards.workshop_id,
      erp_engine_cards.status_rework_sent, erp_engine_cards.status_rework_sent_date,
      erp_engine_cards.status_scrap_confirmed, erp_engine_cards.status_scrap_confirmed_date,
      erp_engine_cards.status_repair_started, erp_engine_cards.status_repair_started_date,
      erp_engine_cards.status_repaired, erp_engine_cards.status_repaired_date,
      erp_engine_cards.status_customer_sent, erp_engine_cards.status_customer_sent_date,
      erp_engine_cards.status_customer_accepted, erp_engine_cards.status_customer_accepted_date,
      erp_engine_cards.status_storage_received, erp_engine_cards.status_storage_received_date,
      erp_engine_cards.status_rejected, erp_engine_cards.status_rejected_date,
      erp_engine_cards.scrap_reason,
      erp_engine_cards.reclamation_flag, erp_engine_cards.reclamation_accepted_date,
      erp_engine_cards.reclamation_customer_reason, erp_engine_cards.reclamation_actual_defect,
      erp_engine_cards.reclamation_defect_nature, erp_engine_cards.reclamation_act_number,
      erp_engine_cards.reclamation_verdict_date, erp_engine_cards.reclamation_shipped_date,
      erp_engine_cards.reclamation_comment, erp_engine_cards.reclamation_verdict,
      erp_engine_cards.reclamation_repair_status,
      erp_engine_cards.repeat_arrival_flag, erp_engine_cards.number_collision_flag,
      erp_engine_cards.previous_arrival_id, erp_engine_cards.merged_into,
      erp_engine_cards.arrival_invoice, erp_engine_cards.shipment_invoice, erp_engine_cards.engine_note,
      erp_engine_cards.docs_state, erp_engine_cards.docs_aspvr_contractor_date,
      erp_engine_cards.docs_vp_sent_date, erp_engine_cards.docs_vp_returned_date,
      erp_engine_cards.docs_aspvr_customer_scan_date, erp_engine_cards.docs_aspvr_customer_original_date,
      erp_engine_cards.docs_track_or_act, erp_engine_cards.docs_aspvr_signed_customer_date,
      erp_engine_cards.docs_aspvr_customer_received, erp_engine_cards.docs_return_scan_date,
      erp_engine_cards.docs_return_original_date, erp_engine_cards.docs_note,
      erp_engine_cards.deleted_at
    ) IS DISTINCT FROM (
      EXCLUDED.engine_number, EXCLUDED.engine_internal_number,
      EXCLUDED.engine_internal_number_year, EXCLUDED.engine_brand_id,
      EXCLUDED.engine_brand, EXCLUDED.arrival_date,
      EXCLUDED.customer_id, EXCLUDED.contract_id,
      EXCLUDED.contract_section_number, EXCLUDED.workshop_id,
      EXCLUDED.status_rework_sent, EXCLUDED.status_rework_sent_date,
      EXCLUDED.status_scrap_confirmed, EXCLUDED.status_scrap_confirmed_date,
      EXCLUDED.status_repair_started, EXCLUDED.status_repair_started_date,
      EXCLUDED.status_repaired, EXCLUDED.status_repaired_date,
      EXCLUDED.status_customer_sent, EXCLUDED.status_customer_sent_date,
      EXCLUDED.status_customer_accepted, EXCLUDED.status_customer_accepted_date,
      EXCLUDED.status_storage_received, EXCLUDED.status_storage_received_date,
      EXCLUDED.status_rejected, EXCLUDED.status_rejected_date,
      EXCLUDED.scrap_reason,
      EXCLUDED.reclamation_flag, EXCLUDED.reclamation_accepted_date,
      EXCLUDED.reclamation_customer_reason, EXCLUDED.reclamation_actual_defect,
      EXCLUDED.reclamation_defect_nature, EXCLUDED.reclamation_act_number,
      EXCLUDED.reclamation_verdict_date, EXCLUDED.reclamation_shipped_date,
      EXCLUDED.reclamation_comment, EXCLUDED.reclamation_verdict,
      EXCLUDED.reclamation_repair_status,
      EXCLUDED.repeat_arrival_flag, EXCLUDED.number_collision_flag,
      EXCLUDED.previous_arrival_id, EXCLUDED.merged_into,
      EXCLUDED.arrival_invoice, EXCLUDED.shipment_invoice, EXCLUDED.engine_note,
      EXCLUDED.docs_state, EXCLUDED.docs_aspvr_contractor_date,
      EXCLUDED.docs_vp_sent_date, EXCLUDED.docs_vp_returned_date,
      EXCLUDED.docs_aspvr_customer_scan_date, EXCLUDED.docs_aspvr_customer_original_date,
      EXCLUDED.docs_track_or_act, EXCLUDED.docs_aspvr_signed_customer_date,
      EXCLUDED.docs_aspvr_customer_received, EXCLUDED.docs_return_scan_date,
      EXCLUDED.docs_return_original_date, EXCLUDED.docs_note,
      EXCLUDED.deleted_at
    );
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Живое зеркало: любая правка атрибутов двигателя пересобирает его карточку.
-- Сносится на cutover вместе с EAV-путём (прецедент R4b).
CREATE OR REPLACE FUNCTION mirror_engine_card_attr()
RETURNS TRIGGER AS $$
DECLARE
  v_type text;
BEGIN
  SELECT t.code INTO v_type
    FROM attribute_defs ad
    JOIN entity_types t ON t.id = ad.entity_type_id
   WHERE ad.id = NEW.attribute_def_id;
  IF v_type = 'engine' THEN
    PERFORM rebuild_erp_engine_card(NEW.entity_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_mirror_engine_card_attr ON attribute_values;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_engine_card_attr
AFTER INSERT OR UPDATE OF value_json, deleted_at ON attribute_values
FOR EACH ROW EXECUTE FUNCTION mirror_engine_card_attr();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mirror_engine_card_entity()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM entity_types t WHERE t.id = NEW.type_id AND t.code = 'engine'
  ) THEN
    RETURN NEW;
  END IF;
  PERFORM rebuild_erp_engine_card(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_mirror_engine_card_entity ON entities;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_engine_card_entity
AFTER INSERT OR UPDATE OF deleted_at ON entities
FOR EACH ROW EXECUTE FUNCTION mirror_engine_card_entity();
--> statement-breakpoint
-- Бэкфилл по всем двигателям (включая soft-deleted: каждой ссылке нужна строка).
SELECT rebuild_erp_engine_card(e.id)
  FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code = 'engine';
