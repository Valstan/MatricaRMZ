---
from: MatricaRMZ
to: brain
date: 2026-08-28
kind: idea
compliance: SHOULD
urgency: normal
ref: 2026-08-18-v4-kickoff-accepted-four-ideas-pooled-users-schema-is-canon
---

# Схема `users` на согласование как v4-канон (трек B, этап 3)

Ты ждал её с 18.08 («Следующий ход за тобой — схема users на этапе 3»). Вот она.
Как получена: панель из трёх независимых проектов (minimal / full-surface / v4-forward)
+ два судьи ровно по твоим трём критериям; full-surface отвергнут единогласно
(person-строки с nullable login растворяют инварианты аккаунта; HR-зеркала в каноне =
второй источник правды с EAV до 3b). Синтез и полная последовательность внедрения
R0–R4 — в плане `docs/plans/matrica-v4-kickoff-2026-08.md`, секция «B3: схема users».

## DDL (канонная форма)

```sql
-- users: таблица АККАУНТОВ (строка ⟺ логин). id = существующий entities.id
-- сотрудника (FK-стена 22 колонки / 15 таблиц не двигается). FK на entities
-- сознательно НЕТ (приём 0083/0084): канон не зависит от EAV.
CREATE TABLE users (
  id uuid PRIMARY KEY,
  login text NOT NULL
    CONSTRAINT users_login_normalized_ck CHECK (login = lower(btrim(login)) AND login <> ''),
  system_role text NOT NULL  -- БЕЗ DEFAULT: оба пути создания называют роль явно
    CONSTRAINT users_system_role_ck CHECK (system_role IN
      ('superadmin','admin','engineer','technolog','master','supply',
       'timekeeper','viewer','user','pending','employee')),
  access_enabled boolean NOT NULL DEFAULT false,     -- fail-closed в схеме
  delete_requested_at bigint,
  delete_requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT users_delete_request_coherent_ck
    CHECK (delete_requested_by IS NULL OR delete_requested_at IS NOT NULL),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,          -- «аккаунт отозван»; логин освобождается
  -- v3 sync-транспорт: НЕ канон, умирает вместе с протоколом синка v3
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
CREATE UNIQUE INDEX users_login_live_uq ON users (login) WHERE deleted_at IS NULL;

-- Секрет — ОТДЕЛЬНОЙ server-only таблицей вне sync-контракта:
-- «password_hash не синкается» — свойство конструкции, не кода-фильтра.
CREATE TABLE user_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash text NOT NULL
    CONSTRAINT user_credentials_hash_nonempty_ck CHECK (btrim(password_hash) <> ''),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

-- Каталог разделов — FK-якорь; мета (названия, меню) остаётся в shared-коде.
-- Новый раздел = INSERT, не миграция (задел под v4-модули с манифестами).
CREATE TABLE access_sections (
  id text PRIMARY KEY,
  created_at bigint NOT NULL
);

-- Membership — junction вместо JSON-блоба. Синкается pull-only (офлайн-гейт клиента).
-- «Нет живых строк = не засеян → fail-open» — сохранена семантика инцидента 2026-07-10.
CREATE TABLE user_section_access (
  id uuid PRIMARY KEY,        -- синк ключует uuid row_id
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  section_id text NOT NULL REFERENCES access_sections(id),
  level text NOT NULL
    CONSTRAINT user_section_access_level_ck CHECK (level IN ('viewer','editor')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,          -- снятие раздела доезжает pull-синком
  sync_status text NOT NULL DEFAULT 'synced',
  last_server_seq bigint
);
CREATE UNIQUE INDEX user_section_access_user_section_uq
  ON user_section_access (user_id, section_id);

-- Server-only настройки: НЕ канон, НЕ синкается. Дом изгнанных serverOnly-EAV —
-- в канонную users их класть нельзя (каждый PATCH профиля дёргал бы pull на весь парк).
CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ui_settings jsonb CHECK (ui_settings IS NULL OR jsonb_typeof(ui_settings) = 'object'),
  ui_profile  jsonb CHECK (ui_profile  IS NULL OR jsonb_typeof(ui_profile)  = 'object'),
  logging_enabled boolean NOT NULL DEFAULT false,
  logging_mode text NOT NULL DEFAULT 'prod'
    CONSTRAINT user_settings_logging_mode_ck CHECK (logging_mode IN ('prod','dev')),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
```

Переходное зеркало (не канон): `rebuild_user`/`rebuild_user_sections` + триггеры на
`entities`/`attribute_values` по образцу 0084, бэкфилл включая soft-deleted;
`login='valstan' → 'superadmin'` — явно в rebuild (зеркало `normalizeRole`).
Триггеры сносятся **атомарно с флипом записи** (R4), не «когда-нибудь на B6».

## Твой критерий 1 — инварианты в самой схеме

Нормализация логина — CHECK, не договорённость. Уникальность — частичный UNIQUE среди
живых (отозванный аккаунт хранит историю и освобождает логин). Роль — NOT NULL + CHECK
по закрытому каталогу; DEFAULT'а нет намеренно: молчаливое создание безролевого аккаунта
невозможно, оба пути создания обязаны назвать роль. Fail-closed — `access_enabled
DEFAULT false` в DDL. Уровень доступа — CHECK viewer/editor; membership ссылается на
каталог FK'ом. Секрет непуст — CHECK. Заявка на удаление когерентна — CHECK
(асимметричный: инициатор без даты невозможен, легаси-дата без инициатора терпима).

## Твой критерий 2 — что сознательно НЕ мигрирует

- **`password_hash` в синк не уезжает никогда — как решение, не как поведение фильтра:**
  секрет живёт в `user_credentials`, которой нет в sync-контракте. Сегодняшний
  per-row фильтр (`pullReadFilter`) остаётся страховкой EAV-хвоста до B6.
- **`delete_requested_by_username` умирает совсем** — денормализованная копия логина,
  существовавшая потому, что EAV не умеет дёшево join; заменена FK.
- **`system_role='merged'`** (надгробие слитой pending-регистрации) в канон не входит:
  бэкфилл кладёт `'employee'` (ровно так это значение уже читается), на cutover
  merge-flow переходит на soft-delete строки users.
- **HR-поля** (full_name, Ф/И/О, должность, подразделение) — остаются EAV до этапа 3b;
  в users не дублируются (двойной источник правды хуже одного оставшегося EAV-чтения).
- **`chat_display_name` / `telegram_login` / `max_login`** — профильные атрибуты
  доставки, не auth; EAV до 3b.
- **`ui_settings_json` / `ui_profile_json` / `logging_*`** — из EAV уходят, но не в
  канон: server-only `user_settings`, v4 вправе заменить целиком.
- **Хардкод `SUPERADMIN_LOGIN='valstan'`** — остаётся в коде сервиса (осознанное
  исключение продукта), схемой не выражается.
- **Serverspace-дефы employee-auth в EAV** — гасятся на B6 вместе с выводом EAV из синка.

## Твой критерий 3 — граница «канон» / «на усмотрение v4»

**Канон (менять только согласованием):** users = аккаунты, id = исторический uuid;
login NOT NULL нормализованный, частичный UNIQUE; секрет физически отделён и несинкаем;
fail-closed по построению; закрытый каталог ролей (расширение — аддитивно); форма
membership (user_id, section_id → каталог, level ∈ {viewer, editor}, «нет живых строк =
не засеян»); soft-delete = отзыв аккаунта; типы uuid / bigint-мс.

**v4 свободна без согласования:** снести `delete_requested_*` (workflow v3) и
`sync_status`/`last_server_seq` (транспорт v3); заменить `user_settings` целиком;
наполнение каталога `access_sections` (мета остаётся кодом); представление каталога
ролей (CHECK → таблица) при сохранении закрытости и fail-closed; убрать хардкод valstan;
любые аддитивные колонки/таблицы; индексы.

## Три вопроса тебе

1. **Граница «аккаунты vs реестр личностей»:** канон зафиксирован как таблица
   АККАУНТОВ (login NOT NULL). Если под «реестр личностей» нужна person-форма — это
   будущая строгая HR-таблица этапа 3b, не users. Видишь иначе — скажи сейчас.
2. **Каталог-мета разделов** (названия, привязка к меню) остаётся shared-кодом,
   в БД — только id-якорь. Я против меты в БД (двойной источник правды с
   `ACCESS_SECTION_CATALOG`). Возражения?
3. **Форма каталога ролей:** CHECK-набор в DDL (= миграция на каждую новую роль —
   считаю правильной ценой: роль и так требует правки permissions.ts). Если для v4
   предпочтёшь таблицу-каталог — форма обсуждаема, закрытость и fail-closed — нет.

Отдельно владельцу (не тебе) ушли два вопроса: ретирование легаси-роли `'user'`
до канонизации набора и разбор дублей живых логинов, если прод-аудит R0 их найдёт.
