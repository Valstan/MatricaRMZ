-- Приказ о СИЗ: профессии с пунктами приложений, «приказные» строки норм, личная
-- карточка СИЗ по форме приложения №3, шаблоны печатных форм.
--
-- Зачем: модуль «Кладовщик» умеет выдачу, но не умеет приказ. В `ppe_norm_lines`
-- нет пункта приложения («Пункт № 1511»), единицы измерения («шт.»/«пара») и формы
-- нормы («1 шт. на 2 года», «до износа», «срок определяется документами изготовителя») —
-- из чего нельзя напечатать форму личной карточки по приложению №3. Связи
-- «должность → норма» тоже нет: `post_title` — свободный текст.
--
-- Аддитивно: только CREATE TABLE / ADD COLUMN / CREATE INDEX, данные не трогаем.
-- FK только на уровне приложения (как 0107 и 0110) — миграция не падает на порядке.
--
-- Разделение двух сущностей, похожих по имени:
--   `ppe_issue_cards` — карточка ВЫДАЧИ (кому что выдали, когда);
--   `ppe_employee_cards` — ЛИЧНАЯ КАРТОЧКА СИЗ по форме приложения №3 (реквизиты
--     сотрудника и его размеры на дату выдачи; одна на сотрудника).
--
-- Смысл реквизитов личной карточки — снимок на момент выдачи: приказ (п. 12)
-- требует зафиксировать ФИО и должность на дату выдачи, а карточка сотрудника
-- может измениться задним числом. Отсюда и подстановка (сервер берёт значения из
-- карточки сотрудника), и возможность ручной правки снимка.
--
-- `ppe_print_templates` — шаблоны печатных форм в БД: секции и колонки, включённые
-- или отключённые, плюс примечание к шапке и подписи в подвале. Набор колонок
-- раньше жил только в localStorage клиента и не переезжал между машинами.
--
-- `ppe_occupation_ref` — справочник профессий: код пункта приложения → название
-- профессии. `ton_kind` различает Типовые отраслевые нормы (767н) и приказ 766н
-- (СИЗ от пониженных температур — по п. 19 приказа выдаются сезонно, то есть
-- поверх основной нормы, а не вместо неё).
ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS occupation_id uuid;
--> statement-breakpoint
ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS source_kind text;
--> statement-breakpoint
ALTER TABLE ppe_norm_sets ADD COLUMN IF NOT EXISTS source_label text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_sets_occupation_idx ON ppe_norm_sets (occupation_id);
--> statement-breakpoint
ALTER TABLE ppe_norm_lines ADD COLUMN IF NOT EXISTS spec_id uuid;
--> statement-breakpoint
ALTER TABLE ppe_norm_lines ADD COLUMN IF NOT EXISTS unit text;
--> statement-breakpoint
ALTER TABLE ppe_norm_lines ADD COLUMN IF NOT EXISTS wear_kind text NOT NULL DEFAULT 'months';
--> statement-breakpoint
-- `wear_months` → nullable: приказ знает нормы без срока («до износа», «срок определяется
-- документами изготовителя»). Такая позиция не «пора выдавать» — срока у неё нет.
-- Старые строки (wear_months задан) читаются как раньше: NULL = «без срока».
ALTER TABLE ppe_norm_lines ALTER COLUMN wear_months DROP NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_lines_spec_idx ON ppe_norm_lines (spec_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_occupation_ref (
  id uuid PRIMARY KEY,
  code text NOT NULL,
  post_title text NOT NULL,
  ton_kind text NOT NULL DEFAULT 'ton',
  ton_label text,
  ton_year integer,
  department_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_occupation_ref_code_uq ON ppe_occupation_ref (code) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_occupation_ref_post_idx ON ppe_occupation_ref (post_title);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_norm_line_specs (
  id uuid PRIMARY KEY,
  occupation_id uuid NOT NULL,
  name text NOT NULL,
  ppe_type text,
  qty integer NOT NULL DEFAULT 1,
  unit text NOT NULL DEFAULT 'шт.',
  wear_kind text NOT NULL DEFAULT 'months',
  wear_months integer,
  sort_order integer NOT NULL DEFAULT 0,
  source_ref text,
  -- Источник строки приказа: 'ton' — Типовые отраслевые нормы 767н, 'order766' —
  -- приказ 766н Прил.4 (СИЗ от пониженных температур). Подпись источника печатается
  -- в колонке «Пункт типовых отраслевых норм» формы приложения №3.
  source_kind text NOT NULL DEFAULT 'ton',
  source_label text,
  nomenclature_id uuid,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_line_specs_occupation_idx ON ppe_norm_line_specs (occupation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_norm_line_specs_nomenclature_idx ON ppe_norm_line_specs (nomenclature_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_employee_cards (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL,
  full_name text,
  -- Фамилия, имя и отчество хранятся РАЗДЕЛЬНО: форма приложения №3 требует три
  -- отдельных поля, и склеенное ФИО пришлось бы разрезать при печати.
  last_name text,
  first_name text,
  middle_name text,
  personnel_no text,
  department_id uuid,
  occupation_id uuid,
  gender text,
  height text,
  size_clothes text,
  size_shoes text,
  size_gloves text,
  size_headgear text,
  size_respirator text,
  size_od text,
  size_hands text,
  hire_date bigint,
  position_changed_date bigint,
  occupation_notes text,
  issued_by text,
  prepared_by text,
  prepared_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_employee_cards_employee_uq ON ppe_employee_cards (employee_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_employee_cards_occupation_idx ON ppe_employee_cards (occupation_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ppe_print_templates (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL DEFAULT 'shared',
  form_key text NOT NULL,
  name text NOT NULL,
  layout_json text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL,
  updated_by text,
  created_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ppe_print_templates_owner_form_name_uq ON ppe_print_templates (owner_id, form_key, name) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ppe_print_templates_form_idx ON ppe_print_templates (form_key);
