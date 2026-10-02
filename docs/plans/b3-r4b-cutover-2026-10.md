# B3/R4b — cutover записи аккаунтов в strict (2026-10)

**Статус:** DEPLOYED релизом 3.58.0 (2026-10-02, PR #1121)
**Основание:** план v4 трек B (R4b) + `PENDING_FOLLOWUPS.md` §«Хвосты R4a».
**Предусловия проверены на проде 02.10 (read-only):** `users:parity` зелёный
(459 карточек / 37 аккаунтов / 36 кредов / 199 доступов / 0 отказов / 0 расхождений),
`users_sync_outbox` пуст, `users_mirror_failures` пусто, парк на сборках с дельта-дверью
(живых ниже v3.19.0 — две машины: CalVer и 1.14.19; после R4b их полный набор начнёт
отказывать ГРОМКО вместо тихого отката — так задумано, автообновление их поднимет).

**Итог деплоя 02.10:** окно с остановкой обоих сервисов; pull до e6606926 ДО migrate;
`0103` применена; старые `trg_mirror_user_*` снесены, `trg_users_publish*` на месте;
parity сразу после: 459/37/36/199/0 чисто; null-seq 0/0; outbox 0. Артефакт
backend-dist run 36982368620 (совпал с HEAD). Приёмка: :3001/:3002 оба 3.58.0,
`/updates/status` latest 3.58.0 без ошибок, blockmap 200, exe == manifest по размеру,
android-план 3.57.0 → 3.58.0 с sha256. Повторный parity под новым кодом: ядро чисто,
2 расхождения `user_settings.ui_profile` — ожидаемо: строки писаны strict-писателями
после рестарта (updated_at минуты деплоя), EAV-атрибуты заморожены; EAV↔strict-сверка
настроек после cutover устарела по построению (источник — strict).

Вне скоупа: HR-карточка (3b), `listEmployeesAuth` на EAV (сырая роль для roleReport —
осознанно), B6 (снятие EAV-веток), клиентские EAV-писатели (их режет backstop).

## Состав работ

### R1. Миграция 0103: догонка → снос EAV-триггеров → триггеры на строгих таблицах

- Догонка: `rebuild_user` + `rebuild_user_sections` по всем сотрудникам (идемпотентно;
  parity и так зелёный — это пояс, а не лечение).
- Снос ТОЛЬКО двух триггеров: `trg_mirror_user_entity`, `trg_mirror_user_attr`.
  Функции `rebuild_*`/`mirror_user_*`/`eav_emp_*` остаются до B6 (их зовёт только
  догонка выше; живых TS-вызывающих нет — проверено грепом).
- Новые триггеры `trg_users_publish` / `trg_user_sections_publish` на строгих таблицах →
  `mirror_enqueue` (существующий): INSERT всегда; UPDATE — только `WHEN
  (OLD.* IS DISTINCT FROM NEW.*)` по зеркалируемым колонкам (иначе холостой бамп
  рассылал бы строку всему парку — тот же шторм, что в 0088).
- `mirror_enqueue` не трогаем (outbox-механика claim/ack уже верная).

### R2. Писатели `employeeAuthService` → strict (drizzle, с WHERE-гардом)

Инвариант 1 (из разбора R4a): прямой писатель несёт `WHERE ... IS DISTINCT FROM ...`
на самой записи — холостой бамп `updated_at` иначе терял бы строку в
`filterStaleBySeqOrUpdatedAt` при безусловном ack (см. R5).

- `setEmployeeAuth` → `users` (login/system_role/access_enabled) + `user_credentials`
  (password_hash). Новая учётка: `id` = id карточки (FK-стена не двигается).
- `setEmployeeSectionAccess` → `user_section_access` (полный набор: upsert живых +
  тумбстоун снятых — та же семантика, что `rebuild_user_sections`).
- `setEmployeeDeleteRequest` → `users.delete_requested_at/by`.
- `setEmployeeUiProfile` / `setEmployeeUiSettings` / `setEmployeeLoggingSettings` →
  `user_settings` (per-key LWW-мердж живёт как был, меняется только хранилище).
- `seedSectionAccessIfMissing` — через те же строгие пути.
- `revokeAccount` (новая именованная функция отзыва): `users.deleted_at` +
  `access_enabled=false` + явные `DELETE` кредов и настроек (каскада на soft-delete
  нет). Зовётся из `confirmUserDelete` после переноса ссылок.
- `readCanonSectionMembership` → `user_section_access`;
  `readEavUiProfile` → `user_settings` (строго парой с писателями — правило «база
  записи из того же хранилища»).
- Роут `POST /users/:id/section-access` → громкий отказ (обновить программу);
  сервис остаётся для серверных вызывающих (дельта-дверь, засев).

### R3. Показ в карточке → реплика

- `SectionAccessMirror` (`EmployeeDetailsPage`) читает membership из реплики
  `user_section_access`, а не из EAV-атрибутов карточки.

### R4. Сторожа — осознанное обновление

- `usersStrictContract.guard.test.ts` (дескрипты «база записи читается из того же
  хранилища»): переезд пройдёт красным by design — обновить описания, а не обойти.
- Parity уже сверяет `user_settings` — ничего не добавлять.

### R5. Sweep «строка новее публикации»

- Страховочный проход публикатора ловит только `last_server_seq IS NULL`.
  Добавить вторую сеть: строки, чей `updated_at` новее штампа их seq
  (время seq — из `ledger_tx_index`), без заявки в outbox — вернуть в очередь.
  Закрывает потерю при проглоченном `mirror_enqueue` (барьер глотает исключение,
  запись коммитится).

## Приёмка

- Gates: typecheck, lint, backend/shared/electron тесты (сторож R4 — обновлён, красный контрольно).
- Живые пробы на пустой PG: цепочка 0000→0103; прямой писатель → триггер → заявка →
  паблишер → pull с seq; холостая запись — тишина (без заявки); тумбстоун отзыва;
  громкий отказ полного набора; parity до/после.
- Деплой — ОТДЕЛЬНЫМ релизом с остановкой сервера (миграция требует тишины:
  догонка + снос триггеров атомарно; см. R4b в v4-плане).
