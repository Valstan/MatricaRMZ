-- B3/R3 — путь публикации зеркала: outbox внутри самих rebuild-функций.
--
-- ЗАЧЕМ. Инкрементальный pull страницует по `last_server_seq > since`, а seq
-- раздаёт только ledger (writeSyncChanges → applyPushBatch.updateSeqAndCollect).
-- Строки users / user_section_access пишут PL/pgSQL-триггеры, которые через путь
-- записи приложения не проходят вовсе, поэтому seq у них NULL — а в SQL
-- `NULL > n` не TRUE, значит таблица не приезжает НИКОГДА. На проде 2026-08-30:
-- 36 строк users, из них с seq — ноль.
--
-- ПОЧЕМУ ИМЕННО OUTBOX. Развилка R3 предлагала «шаг публикации»: писатель после
-- EAV-записи публикует затронутую строку. Беда варианта в слове «писатель» —
-- их много (две серверные двери, generic-EAV из клиентского пуша, скрипты), и
-- обязанность «не забыть опубликовать» пришлось бы держать в каждом. Здесь
-- заявка на публикацию ставится ТАМ ЖЕ, где строка меняется, — внутри
-- rebuild_user / rebuild_user_sections, в той же транзакции. Забыть нельзя:
-- другого места, где зеркало мутирует, не существует. Откатился писатель —
-- откатилась и заявка.
--
-- ШТОРМ. Заявка ставится только на РЕАЛЬНОЕ изменение: оба апсерта получили
-- `WHERE ... IS DISTINCT FROM ...`. Без этого правка телефона сотрудника
-- (любой employee-атрибут дёргает триггер) рассылала бы его строку users всему
-- парку, и самая дешёвая таблица стала бы самым болтливым источником изменений.
-- Побочно уходит и холостой бамп updated_at на каждое срабатывание.

CREATE TABLE IF NOT EXISTS users_sync_outbox (
  row_id uuid NOT NULL,
  table_name text NOT NULL,
  enqueued_at bigint NOT NULL,
  PRIMARY KEY (row_id, table_name)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS users_sync_outbox_at_idx ON users_sync_outbox (enqueued_at);
--> statement-breakpoint

-- Постановка заявки не имеет права стать отказом писателя — та же логика, что у
-- mirror_note_failure (0087). Цена проглоченной заявки — неопубликованная строка;
-- её подбирает страховочный проход публикатора по `last_server_seq IS NULL`.
CREATE OR REPLACE FUNCTION mirror_enqueue(p_row_id uuid, p_table text)
RETURNS void AS $fn$
BEGIN
  INSERT INTO users_sync_outbox (row_id, table_name, enqueued_at)
  VALUES (p_row_id, p_table, (extract(epoch from clock_timestamp()) * 1000)::bigint)
  ON CONFLICT (row_id, table_name) DO UPDATE SET enqueued_at = EXCLUDED.enqueued_at;
EXCEPTION WHEN others THEN
  NULL;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ============================================================================
-- rebuild_user — тело из 0087 с двумя правками:
--   1) снятие логина больше не сносит строку, а гасит её (тумбстоун);
--   2) заявка на публикацию при фактическом изменении.
--
-- ПРО ТУМБСТОУН. Прежний `DELETE FROM users` был верен, пока таблицы не было в
-- sync-контракте. С контрактом он становится дырой: клиент применяет pull
-- только апсертами и строк, которых нет в ответе, НЕ удаляет — то есть снятый
-- аккаунт остался бы жить в реплике каждой машины парка с access_enabled=true,
-- и офлайн-гейт пускал бы его вечно. Гашение вместо сноса: `login NOT NULL`
-- остаётся честным (в строке лежит последний логин), а сам логин освобождается
-- частичным UNIQUE — он считает только живых. Секрет и настройки уходили
-- каскадом, теперь удаляются явно: у снятого аккаунта хэша быть не должно.
-- Разделы НЕ трогаем — их по-прежнему держит rebuild_user_sections из EAV.
-- Это осознанно: R2 сохранил чтение доступов отозванных (иначе раскрылись бы
-- закрытые наряды уволенного владельца), и снятие логина не должно это менять.
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
  v_written uuid;
BEGIN
 BEGIN
  SELECT true, e.deleted_at INTO v_found, v_deleted
    FROM entities e
    JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee'
   WHERE e.id = p_id;
  IF v_found IS DISTINCT FROM true THEN RETURN; END IF;

  v_login := lower(btrim(coalesce(eav_emp_text(p_id, 'login'), '')));

  -- Карточка без логина — не аккаунт. Строка, если была, гасится тумбстоуном
  -- (см. шапку миграции), а не сносится.
  IF v_login = '' THEN
    UPDATE users
       SET deleted_at = coalesce(deleted_at, v_ms),
           access_enabled = false,
           updated_at = v_ms
     WHERE id = p_id
       AND (deleted_at IS NULL OR access_enabled)
    RETURNING id INTO v_written;
    IF v_written IS NOT NULL THEN PERFORM mirror_enqueue(v_written, 'users'); END IF;

    DELETE FROM user_credentials WHERE user_id = p_id;
    DELETE FROM user_settings WHERE user_id = p_id;
    RETURN;
  END IF;

  v_role_raw := lower(btrim(coalesce(eav_emp_text(p_id, 'system_role'), '')));
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

  v_req_at := eav_emp_ms(p_id, 'delete_requested_at');
  v_req_by := eav_emp_uuid(p_id, 'delete_requested_by_id');
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
    coalesce(eav_emp_bool(p_id, 'access_enabled'), false),
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
    deleted_at = EXCLUDED.deleted_at
  -- Только фактическое изменение: иначе любая правка любого employee-атрибута
  -- публиковала бы строку заново (см. «ШТОРМ» в шапке).
  WHERE (
      users.login, users.system_role, users.access_enabled,
      users.delete_requested_at, users.delete_requested_by, users.deleted_at
    ) IS DISTINCT FROM (
      EXCLUDED.login, EXCLUDED.system_role, EXCLUDED.access_enabled,
      EXCLUDED.delete_requested_at, EXCLUDED.delete_requested_by, EXCLUDED.deleted_at
    )
  RETURNING id INTO v_written;
  IF v_written IS NOT NULL THEN PERFORM mirror_enqueue(v_written, 'users'); END IF;

  -- Кред: строка есть, только пока хэш непустой (CHECK непустоты).
  v_hash := coalesce(eav_emp_text(p_id, 'password_hash'), '');
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
  v_ui_settings := eav_emp_jsonb_object(p_id, 'ui_settings_json');
  v_ui_profile := eav_emp_jsonb_object(p_id, 'ui_profile_json');
  v_logging_enabled := eav_emp_bool(p_id, 'logging_enabled');
  v_logging_mode := eav_emp_text(p_id, 'logging_mode');
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
 EXCEPTION WHEN others THEN
  -- ЗЕРКАЛО НИКОГДА НЕ РОНЯЕТ ПИСАТЕЛЯ (барьер 0086, видимость 0087).
  PERFORM mirror_note_failure(p_id, 'rebuild_user', SQLSTATE, SQLERRM);
  RAISE WARNING 'rebuild_user(%) пропущен: % %', p_id, SQLSTATE, SQLERRM;
 END;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ============================================================================
-- rebuild_user_sections — тело из 0087 + заявки на публикацию.
-- Семантика разделов не меняется: отозванный аккаунт по-прежнему сохраняет свои
-- живые строки доступа (решение R2 про закрытые наряды уволенного владельца).
-- ============================================================================
CREATE OR REPLACE FUNCTION rebuild_user_sections(p_id uuid)
RETURNS void AS $fn$
DECLARE
  v_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  v_raw jsonb;
  v_live text[] := ARRAY[]::text[];
  v_written uuid;
  r record;
BEGIN
 BEGIN
  -- Нет строки аккаунта — нет и его разделов.
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_id) THEN RETURN; END IF;

  v_raw := eav_emp_jsonb_object(p_id, 'section_access');

  IF v_raw IS NOT NULL THEN
    FOR r IN SELECT key AS section_id, value AS lvl FROM jsonb_each_text(v_raw) LOOP
      -- Неизвестный раздел (FK) или неизвестный уровень (CHECK) — пропускаем
      -- молча: кривая клиентская строка не должна валить пересборку целиком.
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM access_sections s WHERE s.id = r.section_id);
      -- ВНИМАНИЕ на NULL: jsonb_each_text отдаёт SQL NULL для JSON-null, а
      -- `NULL NOT IN (...)` даёт NULL, и CONTINUE (срабатывает только на TRUE)
      -- НЕ прерывал бы итерацию — level=NULL уехал бы в INSERT и словил
      -- not-null, уронив чужую транзакцию.
      CONTINUE WHEN r.lvl IS NULL OR r.lvl NOT IN ('viewer', 'editor');

      INSERT INTO user_section_access (id, user_id, section_id, level, created_at, updated_at, deleted_at)
      VALUES (gen_random_uuid(), p_id, r.section_id, r.lvl, v_ms, v_ms, NULL)
      ON CONFLICT (user_id, section_id) DO UPDATE SET
        level = EXCLUDED.level,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE (user_section_access.level, user_section_access.deleted_at)
              IS DISTINCT FROM (EXCLUDED.level, NULL::bigint)
      RETURNING id INTO v_written;
      IF v_written IS NOT NULL THEN PERFORM mirror_enqueue(v_written, 'user_section_access'); END IF;

      v_live := array_append(v_live, r.section_id);
    END LOOP;
  END IF;

  -- Всё, чего в живом membership больше нет, — soft-delete. Тумбстоун обязан
  -- доехать до реплики: снятие раздела клиент увидит только строкой, а не её
  -- отсутствием.
  FOR r IN
    WITH upd AS (
      UPDATE user_section_access
         SET deleted_at = v_ms, updated_at = v_ms
       WHERE user_id = p_id
         AND deleted_at IS NULL
         AND NOT (section_id = ANY (v_live))
      RETURNING id
    )
    SELECT id FROM upd
  LOOP
    PERFORM mirror_enqueue(r.id, 'user_section_access');
  END LOOP;
 EXCEPTION WHEN others THEN
  -- См. барьер в rebuild_user: доступы человека не стоят отказа синхронизации.
  PERFORM mirror_note_failure(p_id, 'rebuild_user_sections', SQLSTATE, SQLERRM);
  RAISE WARNING 'rebuild_user_sections(%) пропущен: % %', p_id, SQLSTATE, SQLERRM;
 END;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

-- ============================================================================
-- Разовый бэкфилл заявок: все существующие строки не имеют seq и обязаны быть
-- опубликованы, иначе инкрементальный pull не отдаст их никогда.
-- Порядок публикации задаёт сам публикатор (users раньше доступов, FK).
-- ============================================================================
INSERT INTO users_sync_outbox (row_id, table_name, enqueued_at)
SELECT id, 'users', (extract(epoch from clock_timestamp()) * 1000)::bigint FROM users
ON CONFLICT (row_id, table_name) DO NOTHING;
--> statement-breakpoint

INSERT INTO users_sync_outbox (row_id, table_name, enqueued_at)
SELECT id, 'user_section_access', (extract(epoch from clock_timestamp()) * 1000)::bigint FROM user_section_access
ON CONFLICT (row_id, table_name) DO NOTHING;
