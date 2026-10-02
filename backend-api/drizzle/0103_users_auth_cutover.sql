-- B3/R4b (план b3-r4b-cutover-2026-10): cutover записи аккаунтов в strict.
--
-- До этой миграции источником правды был EAV, а users/user_section_access держались
-- триггерами rebuild_user/rebuild_user_sections (0086-0088). После неё пишут напрямую
-- серверные двери (employeeAuthService), а триггеры EAV сносятся. Порядок важен:
-- сначала догонка (parity и так зелёный — это пояс), затем снос, затем новые триггеры.
--
-- Что осознанно НЕ трогаем: сами функции rebuild_*/mirror_user_*/eav_emp_* (доживут до
-- B6; живых TS-вызывающих у них нет — только догонка выше), eav_attr_text из 0084
-- (чужой), триггеры 0083/0084 (чужие домены).
--
-- Выкат — только с остановкой сервера (тишина на время миграции): между догонкой и
-- сносом триггеров EAV-запись обязана молчать, иначе правка уйдёт мимо зеркала.

-- 1) Финальная догонка зеркала из EAV (идемпотентно; порядок — аккаунты раньше доступов,
-- как в 0088 §бэкфилл: без строки аккаунта rebuild_user_sections молча выходит).
SELECT rebuild_user(e.id)
  FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee';
--> statement-breakpoint
SELECT rebuild_user_sections(e.id)
  FROM entities e JOIN entity_types t ON t.id = e.type_id AND t.code = 'employee';
--> statement-breakpoint

-- 2) Снос EAV-триггеров зеркала (строго по имени — на этих таблицах висят чужие
-- триггеры 0083/0084, их не трогаем; без CASCADE).
DROP TRIGGER IF EXISTS trg_mirror_user_entity ON entities;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_mirror_user_attr ON attribute_values;
--> statement-breakpoint

-- 3) Триггеры публикации на самих строгих таблицах: прямая запись обязана попасть в
-- outbox той же транзакцией (приём R3: забыть нельзя — другого места, где зеркало...
-- теперь таблица — мутирует, нет). mirror_enqueue заявку не роняет (барьер внутри),
-- цена проглоченной заявки — строка без публикации, её ловит страховочный проход
-- публикатора (R5 дотягивает его до «строка новее публикации»).
--
-- WHEN-гард по зеркалируемым колонкам: холостой бамп updated_at без изменения данных
-- рассылал бы строку всему парку (шторм 0088) — и, хуже, терял бы её в
-- filterStaleBySeqOrUpdatedAt при безусловном ack (инвариант 1 R4b).
-- WHEN-гард по зеркалируемым колонкам: OR-цепочка (голый кортеж
-- `(OLD.a, ...) IS DISTINCT FROM (NEW.a, ...)` грамматика WHEN не принимает).
-- Холостой бамп updated_at без изменения данных рассылал бы строку всему парку
-- (шторм 0088) — и, хуже, терял бы её в filterStaleBySeqOrUpdatedAt при
-- безусловном ack (инвариант 1 R4b).
--
-- Два триггера на таблицу, а не один: в WHEN INSERT-триггера ссылаться на OLD
-- запрещено (42P17). Вставка — всегда публикация (новая строка обязана доехать),
-- UPDATE — только на реальном изменении.
CREATE OR REPLACE FUNCTION mirror_users_publish()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM mirror_enqueue(NEW.id, 'users');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_users_publish ON users;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_users_publish_upd ON users;
--> statement-breakpoint
CREATE TRIGGER trg_users_publish
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION mirror_users_publish();
--> statement-breakpoint
CREATE TRIGGER trg_users_publish_upd
AFTER UPDATE ON users
FOR EACH ROW
WHEN (
  OLD.login IS DISTINCT FROM NEW.login
  OR OLD.system_role IS DISTINCT FROM NEW.system_role
  OR OLD.access_enabled IS DISTINCT FROM NEW.access_enabled
  OR OLD.delete_requested_at IS DISTINCT FROM NEW.delete_requested_at
  OR OLD.delete_requested_by IS DISTINCT FROM NEW.delete_requested_by
  OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
)
EXECUTE FUNCTION mirror_users_publish();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION mirror_user_sections_publish()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM mirror_enqueue(NEW.id, 'user_section_access');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_user_sections_publish ON user_section_access;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_user_sections_publish_upd ON user_section_access;
--> statement-breakpoint
CREATE TRIGGER trg_user_sections_publish
AFTER INSERT ON user_section_access
FOR EACH ROW
EXECUTE FUNCTION mirror_user_sections_publish();
--> statement-breakpoint
CREATE TRIGGER trg_user_sections_publish_upd
AFTER UPDATE ON user_section_access
FOR EACH ROW
WHEN (OLD.level IS DISTINCT FROM NEW.level OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at)
EXECUTE FUNCTION mirror_user_sections_publish();
