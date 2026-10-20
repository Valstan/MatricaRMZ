-- Гард первого сейва карточки двигателя.
--
-- Симптом (20.10.2026): оператор заполняет карточку, сохраняет — через полминуты
-- она пуста. Так же и с «Принять двигатели списком». Второй раз заполняешь —
-- держится.
--
-- Причина: клиент отправляет новую сущность и карточку ОДНИМ батчем. Ветка
-- entities применяется раньше ветки карточек, INSERT в entities зажигает
-- trg_mirror_engine_card_entity -> rebuild_erp_engine_card создаёт ПУСТУЮ строку
-- карточки (EAV ведь ещё пуст) со СВОИМ updated_at (clock_timestamp, то есть позже
-- клиентского сохранения) и sync_status='pending'. Строка карточки из того же
-- батча проигрывает ей по LWW (updated_at <= excluded.updated_at ложно), молча:
-- ни seq, ни EAV-следа, ни skipped. Через тик издателя пустая pending-строка
-- уезжает в парк, pull на клиенте затирает локальные значения, а локальная строка
-- уже помечена synced — повтора нет. Второй сейв выживает, потому что сущность
-- уже есть и триггер по entities больше не переоткрывается.
--
-- Лечение: пустую строку зеркало не заводит. Приёмка —
-- engines:first-save-check (живой PG, в CI — джоба migrations-check).

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

  -- Гард первого сейва (20.10.2026): зеркало заводит строку карточки только когда
  -- есть что зеркалить. Пустая строка здесь — не «нет данных», а авторская запись
  -- с серверным updated_at: триггер срабатывает на INSERT сущности, то есть в том же
  -- батче, где клиент привёз заполненную карточку, и обгоняет её по updated_at (LWW).
  -- Дальше пустая строка публикуется в парк и затирает значения у оператора.
  -- У клиента с EAV-путём строку создаст первый же записанный атрибут.
  IF NOT EXISTS (SELECT 1 FROM erp_engine_cards WHERE id = p_id)
     AND NOT EXISTS (
       SELECT 1 FROM attribute_values av
        WHERE av.entity_id = p_id AND av.deleted_at IS NULL
     ) THEN
    RETURN;
  END IF;

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
