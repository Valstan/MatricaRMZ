# План: показывать логин + ФИО везде, где фигурируют клиенты программы

> Запрос владельца (2026-06-05): имена машин (PC41, RMZ4VAL…) ему ничего не говорят, людей он знает по логинам/фамилиям. **Правило на весь проект:** где бы ни показывался клиент/рабочее место программы — показывать **логин + ФИО** пользователя, а не только имя машины.

## Ключевой факт (проверено на проде 2026-06-05)

- `client_settings.lastUsername` **уже существует и пишется** при heartbeat (`/client-settings/settings` → `touchClientSettings`). Значение — **логин приложения** (valstan, peo_irina, alina_goz, fatyhova, nastya_spec), не OS-юзер.
- ФИО per-client **не хранится**, но подтягивается join'ом: employee (entity type `employee`) attr `login` → attr `full_name` (EAV `attribute_values`, value_json — JSON-строка). Join проверен, работает.
- **Схему менять не нужно, миграции нет.** Фича = (1) отдавать `lastUsername` там, где сейчас не отдаётся, (2) резолвить ФИО на чтении, (3) показывать через единый хелпер.

## Подход

ФИО **резолвить на чтении** (join по логину), не денормализовать в `client_settings` — логин стабильный ключ, ФИО может меняться, лишняя колонка/write-путь не нужны.

### 1. Backend — переиспользуемый резолвер
`resolveLoginsToFullNames(logins: string[]): Promise<Map<login, fullName>>` (в `employeeAuthService.ts` или маленький helper). Парсит EAV login/full_name (код парса value_json уже есть в employeeAuthService). Batched (один запрос на набор логинов).

### 2. Backend — обогатить эндпойнты, отдающие клиентов
- `routes/adminClients.ts` GET `/admin/clients` — добавить в строки `lastUsername` + `lastFullName`.
- `services/diagnosticsConsistencyService.ts` (`/diagnostics/consistency`) — уже отдаёт `lastUsername`; добавить `lastFullName`.
- `services/criticalEventsService.ts` — items уже несут `username` + `clientId`; добавить `fullName`.
- Audit (`SuperadminAuditPage` data) — у строк есть `actor` (логин) + `clientId`; колонку «Клиент» обогатить логином+ФИО клиента (резолв clientId→lastUsername→fullName).

### 3. Shared — единый хелпер отображения (enforce правила)
`shared/src/domain/clientLabel.ts`:
- `formatClientLabel({ clientId, hostname, login, fullName })` → напр. `"Фатыхова Наталья Николаевна (fatyhova) · PC41"`.
- `formatClientShort(...)` для узких таблиц → `"fatyhova · PC41"` / с тултипом ФИО.
- Нет логина → имя машины/hostname; логин без employee → логин как есть.
Все сайты зовут один хелпер — так правило держится технически, а не «на честном слове».

### 4. Frontend — сайты показа
- web-admin `ClientAdminPage.tsx` — добавить колонки Логин + ФИО.
- web-admin `DiagnosticsPage.tsx` — рядом с существующим `логин:` добавить ФИО.
- electron `SuperadminAuditPage.tsx` — колонка «Клиент» → `логин (ФИО) · машина`.
- electron `SettingsPage.tsx` (критические события) — рендерить username + ФИО.
- electron `AdminPage`/любой view «рабочие места»/клиенты, если есть.

### 5. Документация — само правило
В `docs/PROJECT_STATE.md` (раздел правил) + `CLAUDE.md` (Key architecture decisions): «Клиенты программы везде (UI, диагностика, отчёты, ops-запросы) показывать как логин + ФИО (`client_settings.lastUsername` → employee `full_name`), не только имя машины. Использовать `shared/clientLabel`.»

### 6. Ops-запросы (мои) — принять сразу
В любых запросах по `client_settings` всегда SELECT `last_username` + резолв ФИО (готовый шаблон-запрос — в этом плане выше). Без кода, сразу.

## Edge cases
- `lastUsername` = null (старые клиенты / heartbeat до логина) → показывать только машину.
- логин не матчится с employee (удалён/переименован) → показывать логин без ФИО.
- общая машина, несколько людей → `lastUsername` = только последний вход (MVP). Позже: distinct-логины per client из audit-лога (отдельный шаг).

## Риск / объём
Низкий: без схемы/миграции, backend = read-side join, frontend = аддитивные колонки. ~8–10 файлов. Можно одним PR или поэтапно (PR1: shared-хелпер + backend + ClientAdminPage; PR2: диагностика/аудит/крит.события; PR3: доки+правило).

## Проверка
- `pnpm -r typecheck`/`lint`.
- web-admin: список клиентов показывает логин+ФИО.
- electron: аудит/крит.события/настройки показывают логин+ФИО (CDP-smoke verifier-electron).
- Реальные данные прода уже подтверждают резолв (5 логинов → ФИО).
