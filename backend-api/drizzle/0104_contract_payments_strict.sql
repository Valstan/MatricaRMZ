-- B2-хвост трека B (план contract-payments-strict-2026-10): платежи контрактов уходят
-- из EAV JSON `contract_payments` в строгие нормализованные таблицы. id строк — uuid
-- из прежнего JSON (бэкфилл 1:1 без remap). sync-колонки сразу: вход в контракт — тем же
-- релизом (прецедент #720/#721), публикатор словарей разберёт pending-строки.
-- rebuild_erp_contract НЕ трогаем: payments_json остаётся зеркалом для AI/отладки.

CREATE TABLE IF NOT EXISTS erp_contract_payment_slots (
  id uuid PRIMARY KEY,
  contract_id uuid NOT NULL REFERENCES erp_contracts(id),
  section_key text NOT NULL,
  engine_brand_id uuid,
  engine_id uuid,
  contract_price_kop bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_contract_payment_slots_contract_idx ON erp_contract_payment_slots (contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_contract_payment_slots_engine_idx ON erp_contract_payment_slots (engine_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_contract_payment_slots_seq_idx ON erp_contract_payment_slots (last_server_seq);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS erp_contract_payments (
  id uuid PRIMARY KEY,
  slot_id uuid NOT NULL REFERENCES erp_contract_payment_slots(id),
  date text NOT NULL,
  amount_kop bigint NOT NULL,
  kind text NOT NULL,
  note text,
  countdown_start boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_contract_payments_slot_idx ON erp_contract_payments (slot_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS erp_contract_payments_seq_idx ON erp_contract_payments (last_server_seq);
--> statement-breakpoint
-- Бэкфилл и живое зеркало EAV→strict — одна функция на контракт.
-- Источник: EAV-атрибут `contract_payments` (бэкфилл — через его зеркало
-- erp_contracts.payments_json, которое триггерно равно атрибуту).
-- Толерантна, как parseContractPayments: мусорные строки пропускаются.
-- Ключ секции канонизируется (всё, что не «ДС {seq}», — основной договор: то же правило,
-- что canonicalContractSectionKey). Строки, исчезнувшие из JSON, гасятся (soft-delete):
-- зеркало — полная замена по контракту, а не добавление.
-- pending — только на реальном изменении (WHERE-гард, приём users R3 «ШТОРМ»): иначе
-- каждая правка любого платежа рассылала бы весь контракт парку.
CREATE OR REPLACE FUNCTION sync_contract_payments(p_contract_id uuid, p_json text)
RETURNS void AS $$
DECLARE
  j jsonb;
  s jsonb;
  p jsonb;
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_slot_id uuid;
  v_section text;
  v_brand uuid;
  v_engine uuid;
  v_price bigint;
  v_pay_id uuid;
  v_date text;
  v_amount bigint;
  v_kind text;
  v_note text;
  v_cd boolean;
  v_seen_slots uuid[] := '{}';
  v_seen_pays uuid[] := '{}';
BEGIN
  BEGIN
    j := p_json::jsonb;
  EXCEPTION WHEN others THEN
    j := NULL;
  END;
  IF j IS NULL OR jsonb_typeof(j -> 'slots') IS DISTINCT FROM 'array' THEN
    j := jsonb_build_object('slots', jsonb_build_array());
  END IF;
  FOR s IN SELECT * FROM jsonb_array_elements(j -> 'slots') LOOP
    BEGIN
      v_slot_id := nullif(btrim(s ->> 'id'), '')::uuid;
      v_section := btrim(coalesce(s ->> 'sectionKey', ''));
      IF v_section = '' THEN CONTINUE; END IF;
      IF v_section !~ '^ДС\s' THEN v_section := 'primary'; END IF;
      BEGIN
        v_brand := nullif(btrim(coalesce(s ->> 'engineBrandId', '')), '')::uuid;
      EXCEPTION WHEN others THEN
        v_brand := NULL;
      END;
      BEGIN
        v_engine := nullif(btrim(coalesce(s ->> 'engineId', '')), '')::uuid;
      EXCEPTION WHEN others THEN
        v_engine := NULL;
      END;
      BEGIN
        v_price := (s ->> 'contractPriceKop')::bigint;
      EXCEPTION WHEN others THEN
        v_price := NULL;
      END;
      INSERT INTO erp_contract_payment_slots
        (id, contract_id, section_key, engine_brand_id, engine_id, contract_price_kop,
         created_at, updated_at, deleted_at, sync_status)
      VALUES
        (v_slot_id, p_contract_id, v_section, v_brand, v_engine, v_price,
         v_ms, v_ms, NULL, 'pending')
      ON CONFLICT (id) DO UPDATE SET
        contract_id = EXCLUDED.contract_id,
        section_key = EXCLUDED.section_key,
        engine_brand_id = EXCLUDED.engine_brand_id,
        engine_id = EXCLUDED.engine_id,
        contract_price_kop = EXCLUDED.contract_price_kop,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL,
        sync_status = 'pending'
      WHERE (
          erp_contract_payment_slots.contract_id, erp_contract_payment_slots.section_key,
          erp_contract_payment_slots.engine_brand_id, erp_contract_payment_slots.engine_id,
          erp_contract_payment_slots.contract_price_kop, erp_contract_payment_slots.deleted_at
        ) IS DISTINCT FROM (
          EXCLUDED.contract_id, EXCLUDED.section_key,
          EXCLUDED.engine_brand_id, EXCLUDED.engine_id,
          EXCLUDED.contract_price_kop, NULL::bigint
        );
      v_seen_slots := v_seen_slots || v_slot_id;
      IF jsonb_typeof(s -> 'payments') IS DISTINCT FROM 'array' THEN CONTINUE; END IF;
      FOR p IN SELECT * FROM jsonb_array_elements(s -> 'payments') LOOP
        BEGIN
          v_pay_id := nullif(btrim(p ->> 'id'), '')::uuid;
          BEGIN
            v_amount := (p ->> 'amountKop')::bigint;
          EXCEPTION WHEN others THEN
            v_amount := NULL;
          END;
          v_kind := btrim(coalesce(p ->> 'kind', ''));
          IF v_amount IS NULL THEN CONTINUE; END IF;
          IF v_kind NOT IN ('contract_price', 'advance', 'extra_advance', 'final') THEN CONTINUE; END IF;
          v_date := coalesce(p ->> 'date', '');
          v_note := nullif(btrim(coalesce(p ->> 'note', '')), '');
          -- Строго `true`, как parseContractPayments: PG-каст принял бы и 'yes'.
          v_cd := coalesce(p ->> 'countdownStart', '') = 'true';
          INSERT INTO erp_contract_payments
            (id, slot_id, date, amount_kop, kind, note, countdown_start,
             created_at, updated_at, deleted_at, sync_status)
          VALUES
            (v_pay_id, v_slot_id, v_date, v_amount, v_kind, v_note, v_cd,
             v_ms, v_ms, NULL, 'pending')
          ON CONFLICT (id) DO UPDATE SET
            slot_id = EXCLUDED.slot_id,
            date = EXCLUDED.date,
            amount_kop = EXCLUDED.amount_kop,
            kind = EXCLUDED.kind,
            note = EXCLUDED.note,
            countdown_start = EXCLUDED.countdown_start,
            updated_at = EXCLUDED.updated_at,
            deleted_at = NULL,
            sync_status = 'pending'
          WHERE (
              erp_contract_payments.slot_id, erp_contract_payments.date,
              erp_contract_payments.amount_kop, erp_contract_payments.kind,
              erp_contract_payments.note, erp_contract_payments.countdown_start,
              erp_contract_payments.deleted_at
            ) IS DISTINCT FROM (
              EXCLUDED.slot_id, EXCLUDED.date,
              EXCLUDED.amount_kop, EXCLUDED.kind,
              EXCLUDED.note, EXCLUDED.countdown_start,
              NULL::bigint
            );
          v_seen_pays := v_seen_pays || v_pay_id;
        EXCEPTION WHEN others THEN
          NULL;
        END;
      END LOOP;
    EXCEPTION WHEN others THEN
      NULL;
    END;
  END LOOP;
  UPDATE erp_contract_payments SET deleted_at = v_ms, updated_at = v_ms, sync_status = 'pending'
   WHERE slot_id IN (SELECT id FROM erp_contract_payment_slots WHERE contract_id = p_contract_id)
     AND deleted_at IS NULL AND NOT (id = ANY (v_seen_pays));
  UPDATE erp_contract_payment_slots SET deleted_at = v_ms, updated_at = v_ms, sync_status = 'pending'
   WHERE contract_id = p_contract_id AND deleted_at IS NULL AND NOT (id = ANY (v_seen_slots));
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Живое зеркало на переходный период: старые клиенты пишут EAV-атрибут, зеркало
-- переносит в strict. Сносится вместе с EAV-путём (cutover), как rebuild-триггеры R4b.
-- Обратного зеркала strict→EAV нет намеренно (петля): strict пишут только новые клиенты.
CREATE OR REPLACE FUNCTION mirror_contract_payments_attr()
RETURNS TRIGGER AS $$
DECLARE
  v_code text;
  v_type text;
BEGIN
  SELECT ad.code, t.code INTO v_code, v_type
    FROM attribute_defs ad
    JOIN entity_types t ON t.id = ad.entity_type_id
   WHERE ad.id = NEW.attribute_def_id;
  IF v_type = 'contract' AND v_code = 'contract_payments' THEN
    PERFORM sync_contract_payments(NEW.entity_id, eav_attr_text(NEW.entity_id, 'contract_payments'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_mirror_contract_payments_attr ON attribute_values;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_contract_payments_attr
AFTER INSERT OR UPDATE OF value_json, deleted_at ON attribute_values
FOR EACH ROW EXECUTE FUNCTION mirror_contract_payments_attr();
--> statement-breakpoint
-- Бэкфилл из зеркала erp_contracts.payments_json (триггерно равно EAV-атрибуту).
SELECT sync_contract_payments(c.id, c.payments_json)
  FROM erp_contracts c WHERE c.payments_json IS NOT NULL;
