-- Именованные шаблоны актов по марке двигателя (editable-engine-acts PR4).
--
-- Хранит «шапку» акта комплектности/дефектовки на марку двигателя: состав комиссии,
-- гриф «Утверждаю» и список пунктов «Состояние при поступлении» (только ярлыки).
-- НЕ хранит строки деталей — они уже привязаны к марке через directory_parts.brand_links_json
-- (PartSpecBrandLink.inCompletenessAct/inDefectAct).
--
-- payload : JSON-объект { commissionMembers, approverGrif, conditionItems } — text, как в
--           work_order_templates (JSON.parse на чтение, stringify на запись).
-- Ключ уникальности — (engine_brand_id, name): несколько именованных шаблонов на марку.
--
-- Not synced to clients (server-only REST, как work_order_templates).

CREATE TABLE IF NOT EXISTS "engine_act_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "engine_brand_id" text NOT NULL,
  "name" text NOT NULL,
  "payload" text NOT NULL DEFAULT '{}',
  "updated_at" bigint NOT NULL,
  "updated_by" text,
  CONSTRAINT "engine_act_templates_name_len_ck"
    CHECK (length("name") BETWEEN 1 AND 100)
);

CREATE INDEX IF NOT EXISTS "engine_act_templates_brand_idx"
  ON "engine_act_templates" ("engine_brand_id");

CREATE UNIQUE INDEX IF NOT EXISTS "engine_act_templates_brand_name_uq"
  ON "engine_act_templates" ("engine_brand_id", "name");
