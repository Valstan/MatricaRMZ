-- B3/R1 (план matrica-v4-kickoff, трек B этап 3): аккаунты, креды, доступы и
-- настройки — строгие таблицы. Схема канонизирована brain'ом 2026-08-29
-- (письмо 2026-08-29-users-schema-ack-three-answers-and-user-retirement-go).
--
-- Как и 0083/0084: источник правды ПОКА остаётся в EAV (клиенты пишут офлайн
-- через синк), строгие таблицы держатся полными и свежими ТРИГГЕРАМИ — одна
-- точка на все пути записи. Читатели в этом релизе НЕ трогаются (это R2).
-- Триггеры сносятся атомарно с флипом записи (R4), не «на B6»: вооружённый
-- триггер поверх прямых записей затирал бы канон из замороженного EAV.
--
-- Ключевое отличие от 0083/0084: `users` — таблица АККАУНТОВ, а не зеркало
-- карточек сотрудников. Строка ⟺ логин. Карточка сотрудника без логина (а таких
-- большинство: рабочие цеха в программу не заходят) строки в `users` НЕ имеет.
-- Поэтому rebuild_user умеет и удалять: сняли логин — аккаунта нет.
--
-- id = entities.id (LOCKED, FK-стена не двигается). FK на entities сознательно
-- НЕТ — канон не должен зависеть от EAV (приём 0083/0084).

-- ============================================================================
-- 1) Каталог-якорь разделов. Мета (titleRu/menuTabs) остаётся в shared-коде:
-- brain 2026-08-29 согласовал, что дублировать её в БД — второй источник правды
-- (класс #087). Здесь только id, чтобы user_section_access мог сослаться FK.
-- Новый раздел = INSERT, а не миграция схемы.
-- ============================================================================
CREATE TABLE IF NOT EXISTS access_sections (
  id text PRIMARY KEY
);
--> statement-breakpoint

INSERT INTO access_sections (id) VALUES
  ('production'),
  ('work_orders'),
  ('restricted_work_orders'),
  ('supply'),
  ('warehouse'),
  ('contracts'),
  ('people'),
  ('reports'),
  ('directories'),
  ('administration')
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- ============================================================================
-- 2) users — аккаунты.
-- Инварианты живут в самой схеме (эталон, отмеченный brain'ом): CHECK,
-- частичный UNIQUE, NOT NULL без DEFAULT там, где значение обязано быть названо.
-- ============================================================================
CREATE TABLE users (
  id uuid PRIMARY KEY,

  -- Логин нормализован уже на входе (normalizeLogin = trim+lower). CHECK делает
  -- это свойством схемы, а не соглашением вызывающих.
  login text NOT NULL
    CONSTRAINT users_login_normalized_ck CHECK (login = lower(btrim(login)) AND btrim(login) <> ''),

  -- NOT NULL БЕЗ DEFAULT: оба пути создания называют роль явно, молчаливого
  -- дефолта быть не должно — именно молчаливый дефолт раздал легаси-'user'
  -- (RCA 2026-08-28). Набор закрыт CHECK'ом по SYSTEM_ROLE_CATALOG (12 ролей).
  -- 'user' пока в наборе: три живых аккаунта ждут пересадки на 'storekeeper'
  -- после обновления парка; выводится отдельной миграцией, не этой.
  -- 'merged' в каталог НЕ входит — бэкфилл нормализует его в 'employee'
  -- (= сегодняшняя семантика чтения normalizeRole).
  system_role text NOT NULL
    CONSTRAINT users_system_role_ck CHECK (system_role IN (
      'superadmin', 'admin',
      'engineer', 'technolog', 'master', 'supply', 'storekeeper', 'timekeeper', 'viewer',
      'user', 'pending', 'employee'
    )),

  -- fail-closed в самой схеме: доступ надо включить, а не забыть выключить.
  access_enabled boolean NOT NULL DEFAULT false,

  delete_requested_at bigint,
  delete_requested_by uuid
    CONSTRAINT users_delete_requested_by_fk REFERENCES users(id) ON DELETE SET NULL,

  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  -- «Аккаунт отозван». Логин при этом освобождается — см. частичный UNIQUE ниже.
  deleted_at bigint,

  -- Транспорт протокола синка. НЕ канон: умирает вместе с протоколом v3.
  -- Без него pullChangesSince физически не работает (оба судьи схемы).
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint,

  -- Асимметрично намеренно: инициатор без даты невозможен, дата без инициатора
  -- терпима — в легаси-EAV встречается delete_requested_at без парного id.
  CONSTRAINT users_delete_request_ck CHECK (delete_requested_by IS NULL OR delete_requested_at IS NOT NULL)
);
--> statement-breakpoint

CREATE INDEX users_seq_idx ON users (last_server_seq);
--> statement-breakpoint
CREATE INDEX users_role_idx ON users (system_role);
--> statement-breakpoint

-- ============================================================================
-- 3) Секрет отделён СТРУКТУРНО, а не фильтром кода: `user_credentials` просто
-- отсутствует в sync-контракте, поэтому «password_hash не синкается» —
-- свойство конструкции. pullReadFilter остаётся страховкой EAV-хвоста до B6.
-- ============================================================================
CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY
    CONSTRAINT user_credentials_user_fk REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL
    CONSTRAINT user_credentials_hash_ck CHECK (btrim(password_hash) <> ''),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint

-- ============================================================================
-- 4) Доступы по разделам — junction, а не JSON.
-- Синк ключует строки по uuid row_id, поэтому у строки собственный id.
-- UNIQUE(user_id, section_id) ПОЛНЫЙ, не частичный: снятие раздела — это
-- soft-delete существующей строки (чтобы удаление доехало pull-синком), а
-- повторная выдача оживляет её же. Новых строк на ту же пару не появляется,
-- поэтому M12 (глобальный unique считает soft-deleted) здесь не грабля, а
-- ровно нужное поведение.
-- ============================================================================
CREATE TABLE user_section_access (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL
    CONSTRAINT user_section_access_user_fk REFERENCES users(id) ON DELETE CASCADE,
  section_id text NOT NULL
    CONSTRAINT user_section_access_section_fk REFERENCES access_sections(id),
  level text NOT NULL
    CONSTRAINT user_section_access_level_ck CHECK (level IN ('viewer', 'editor')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint,
  CONSTRAINT user_section_access_pair_uq UNIQUE (user_id, section_id)
);
--> statement-breakpoint

CREATE INDEX user_section_access_user_idx ON user_section_access (user_id);
--> statement-breakpoint
CREATE INDEX user_section_access_seq_idx ON user_section_access (last_server_seq);
--> statement-breakpoint

-- ============================================================================
-- 5) user_settings — дом изгнанных serverOnly-EAV. НЕ канон и НЕ синкается:
-- в канонной users им нельзя, иначе каждый PATCH профиля дёргал бы pull строки
-- users на весь парк.
-- ============================================================================
CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY
    CONSTRAINT user_settings_user_fk REFERENCES users(id) ON DELETE CASCADE,
  ui_settings jsonb
    CONSTRAINT user_settings_ui_settings_ck CHECK (ui_settings IS NULL OR jsonb_typeof(ui_settings) = 'object'),
  ui_profile jsonb
    CONSTRAINT user_settings_ui_profile_ck CHECK (ui_profile IS NULL OR jsonb_typeof(ui_profile) = 'object'),
  logging_enabled boolean,
  logging_mode text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
--> statement-breakpoint

-- ============================================================================
-- 6) Помощники чтения EAV. eav_attr_text / _ms / _uuid заведены миграцией 0084
-- (CREATE OR REPLACE там же) — не переопределяем. Нужны два новых.
-- ============================================================================

-- Булев атрибут: в EAV лежит JSON true/false, но встречается и строка.
CREATE OR REPLACE FUNCTION eav_attr_bool(p_entity uuid, p_code text)
RETURNS boolean AS $fn$
DECLARE v_txt text := eav_attr_text(p_entity, p_code);
BEGIN
  IF v_txt IS NULL THEN RETURN NULL; END IF;
  RETURN lower(v_txt) IN ('true', 't', '1', 'yes');
END;
$fn$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

-- JSON-объект из текстового EAV-значения. Мусор и не-объекты — в NULL, чтобы
-- CHECK jsonb_typeof='object' не валил rebuild на кривой легаси-строке.
CREATE OR REPLACE FUNCTION eav_attr_jsonb_object(p_entity uuid, p_code text)
RETURNS jsonb AS $fn$
DECLARE v_txt text := eav_attr_text(p_entity, p_code); v_out jsonb;
BEGIN
  IF v_txt IS NULL THEN RETURN NULL; END IF;
  BEGIN
    v_out := v_txt::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF v_out IS NULL OR jsonb_typeof(v_out) <> 'object' THEN RETURN NULL; END IF;
  RETURN v_out;
END;
$fn$ LANGUAGE plpgsql STABLE;
--> statement-breakpoint

-- ============================================================================
-- 7) rebuild_user — пересобирает аккаунт целиком из живых EAV-атрибутов.
-- Зеркало normalizeRole (employeeAuthService.ts): login='valstan' → superadmin,
-- 'merged' и любая неизвестная роль → 'employee' (fail-closed, H7 шаг «в»).
-- ============================================================================
CREATE OR REPLACE FUNCTION rebuild_user(p_id uuid)
RETURNS void AS $fn$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_deleted bigint;
  v_found boolean;
  v_login text;
  v_role_raw text;
  v_role text;
  v_hash text;
  v_req_by uuid;
  v_req_at bigint;
  v_ui_settings jsonb;
  v_ui_profile jsonb;
  v_logging_enabled boolean;
  v_logging_mode text;
BEGIN
  SELECT true, e.deleted_at INTO v_found, v_deleted
    FROM entities e
    JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee'
   WHERE e.id = p_id;
  IF v_found IS DISTINCT FROM true THEN RETURN; END IF;

  v_login := lower(btrim(coalesce(eav_attr_text(p_id, 'login'), '')));

  -- Карточка без логина — не аккаунт. Если строка была (логин сняли) — сносим:
  -- зеркало производное, а `login NOT NULL` обязан оставаться честным.
  -- Кред / настройки / разделы уезжают каскадом.
  IF v_login = '' THEN
    DELETE FROM users WHERE id = p_id;
    RETURN;
  END IF;

  v_role_raw := lower(btrim(coalesce(eav_attr_text(p_id, 'system_role'), '')));
  IF v_login = 'valstan' THEN
    v_role := 'superadmin';
  ELSIF v_role_raw IN (
    'superadmin', 'admin',
    'engineer', 'technolog', 'master', 'supply', 'storekeeper', 'timekeeper', 'viewer',
    'user', 'pending', 'employee'
  ) THEN
    v_role := v_role_raw;
  ELSE
    -- 'merged', опечатка, пусто — всё сюда (fail-closed).
    v_role := 'employee';
  END IF;

  v_req_at := eav_attr_ms(p_id, 'delete_requested_at');
  v_req_by := eav_attr_uuid(p_id, 'delete_requested_by_id');
  -- FK-страховка: инициатор, у которого нет своего аккаунта (карточка без
  -- логина, или его ещё не создал первый проход бэкфилла) — в NULL.
  IF v_req_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = v_req_by) THEN
    v_req_by := NULL;
  END IF;
  -- CHECK асимметричен: инициатор без даты невозможен.
  IF v_req_at IS NULL THEN v_req_by := NULL; END IF;

  INSERT INTO users (
    id, login, system_role, access_enabled,
    delete_requested_at, delete_requested_by,
    created_at, updated_at, deleted_at
  )
  VALUES (
    p_id, v_login, v_role,
    coalesce(eav_attr_bool(p_id, 'access_enabled'), false),
    v_req_at, v_req_by,
    v_ms, v_ms, v_deleted
  )
  ON CONFLICT (id) DO UPDATE SET
    login = EXCLUDED.login,
    system_role = EXCLUDED.system_role,
    access_enabled = EXCLUDED.access_enabled,
    delete_requested_at = EXCLUDED.delete_requested_at,
    delete_requested_by = EXCLUDED.delete_requested_by,
    updated_at = EXCLUDED.updated_at,
    deleted_at = EXCLUDED.deleted_at;

  -- Кред: строка есть, только пока хэш непустой (CHECK непустоты).
  v_hash := coalesce(eav_attr_text(p_id, 'password_hash'), '');
  IF btrim(v_hash) = '' THEN
    DELETE FROM user_credentials WHERE user_id = p_id;
  ELSE
    INSERT INTO user_credentials (user_id, password_hash, created_at, updated_at)
    VALUES (p_id, v_hash, v_ms, v_ms)
    ON CONFLICT (user_id) DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      updated_at = EXCLUDED.updated_at;
  END IF;

  -- Настройки: строка держится, только пока есть хоть одно значение.
  v_ui_settings := eav_attr_jsonb_object(p_id, 'ui_settings_json');
  v_ui_profile := eav_attr_jsonb_object(p_id, 'ui_profile_json');
  v_logging_enabled := eav_attr_bool(p_id, 'logging_enabled');
  v_logging_mode := eav_attr_text(p_id, 'logging_mode');
  IF v_ui_settings IS NULL AND v_ui_profile IS NULL AND v_logging_enabled IS NULL AND v_logging_mode IS NULL THEN
    DELETE FROM user_settings WHERE user_id = p_id;
  ELSE
    INSERT INTO user_settings (user_id, ui_settings, ui_profile, logging_enabled, logging_mode, created_at, updated_at)
    VALUES (p_id, v_ui_settings, v_ui_profile, v_logging_enabled, v_logging_mode, v_ms, v_ms)
    ON CONFLICT (user_id) DO UPDATE SET
      ui_settings = EXCLUDED.ui_settings,
      ui_profile = EXCLUDED.ui_profile,
      logging_enabled = EXCLUDED.logging_enabled,
      logging_mode = EXCLUDED.logging_mode,
      updated_at = EXCLUDED.updated_at;
  END IF;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ============================================================================
-- 8) rebuild_user_sections — JSON `section_access` в строки junction.
-- Снятый раздел не удаляется, а помечается deleted_at: снятие обязано доехать
-- pull-синком до клиента, иначе на нём останется прежний доступ.
-- ============================================================================
CREATE OR REPLACE FUNCTION rebuild_user_sections(p_id uuid)
RETURNS void AS $fn$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_raw jsonb;
  v_live text[] := ARRAY[]::text[];
  r record;
BEGIN
  -- Нет аккаунта — нет и его разделов (каскад уже отработал).
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_id) THEN RETURN; END IF;

  v_raw := eav_attr_jsonb_object(p_id, 'section_access');

  IF v_raw IS NOT NULL THEN
    FOR r IN SELECT key AS section_id, value AS lvl FROM jsonb_each_text(v_raw) LOOP
      -- Неизвестный раздел (FK) или неизвестный уровень (CHECK) — пропускаем
      -- молча: кривая клиентская строка не должна валить пересборку целиком.
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM access_sections s WHERE s.id = r.section_id);
      CONTINUE WHEN r.lvl NOT IN ('viewer', 'editor');

      INSERT INTO user_section_access (id, user_id, section_id, level, created_at, updated_at, deleted_at)
      VALUES (gen_random_uuid(), p_id, r.section_id, r.lvl, v_ms, v_ms, NULL)
      ON CONFLICT (user_id, section_id) DO UPDATE SET
        level = EXCLUDED.level,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL;

      v_live := array_append(v_live, r.section_id);
    END LOOP;
  END IF;

  -- Всё, чего в живом membership больше нет, — soft-delete.
  UPDATE user_section_access
     SET deleted_at = v_ms, updated_at = v_ms
   WHERE user_id = p_id
     AND deleted_at IS NULL
     AND NOT (section_id = ANY (v_live));
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ============================================================================
-- 9) Триггеры. Образец 0084: entities (создание / soft-delete / восстановление)
-- + attribute_values (любая правка атрибута, включая снятие).
-- ============================================================================
CREATE OR REPLACE FUNCTION mirror_user_entity()
RETURNS TRIGGER AS $fn$
DECLARE v_type text;
BEGIN
  SELECT t.code INTO v_type FROM entity_types t WHERE t.id = NEW.type_id;
  IF v_type = 'employee' THEN
    PERFORM rebuild_user(NEW.id);
    PERFORM rebuild_user_sections(NEW.id);
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_mirror_user_entity ON entities;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_user_entity
AFTER INSERT OR UPDATE OF deleted_at ON entities
FOR EACH ROW EXECUTE FUNCTION mirror_user_entity();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION mirror_user_attr()
RETURNS TRIGGER AS $fn$
DECLARE v_type text;
BEGIN
  SELECT t.code INTO v_type
    FROM attribute_defs ad
    JOIN entity_types t ON t.id = ad.entity_type_id
   WHERE ad.id = NEW.attribute_def_id;
  IF v_type = 'employee' THEN
    PERFORM rebuild_user(NEW.entity_id);
    PERFORM rebuild_user_sections(NEW.entity_id);
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_mirror_user_attr ON attribute_values;
--> statement-breakpoint
CREATE TRIGGER trg_mirror_user_attr
AFTER INSERT OR UPDATE OF value_json, deleted_at ON attribute_values
FOR EACH ROW EXECUTE FUNCTION mirror_user_attr();
--> statement-breakpoint

-- ============================================================================
-- 10) Бэкфилл. Включая soft-deleted (0083: «каждой ссылке нужна строка»).
-- Два прохода по users: второй заполняет delete_requested_by, чей аккаунт на
-- первом проходе мог быть ещё не создан.
-- ============================================================================
SELECT rebuild_user(e.id)
  FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee';
--> statement-breakpoint

SELECT rebuild_user(e.id)
  FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee';
--> statement-breakpoint

SELECT rebuild_user_sections(u.id) FROM users u;
--> statement-breakpoint

-- ============================================================================
-- 11) Частичный UNIQUE логина — ПОСЛЕ бэкфилла, чтобы дубли живых логинов дали
-- внятную ошибку, а не «duplicate key» посреди пересборки. R0-аудит 2026-08-28
-- нашёл на проде ноль дублей среди 26 живых; проверка — страховка на случай,
-- если между аудитом и накатом кто-то успел завести дубль.
-- Среди отозванных аккаунтов дубли ЛЕГАЛЬНЫ: логин освобождается (M12 —
-- глобальный unique считал бы soft-deleted и ломал бы cold-rebuild).
-- ============================================================================
DO $mig$
DECLARE v_dup text;
BEGIN
  SELECT string_agg(login, ', ') INTO v_dup
    FROM (SELECT login FROM users WHERE deleted_at IS NULL GROUP BY login HAVING count(*) > 1) d;
  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION 'дубли живых логинов, бэкфилл users невозможен: %', v_dup;
  END IF;
END;
$mig$;
--> statement-breakpoint

CREATE UNIQUE INDEX users_login_live_uq ON users (login) WHERE deleted_at IS NULL;
