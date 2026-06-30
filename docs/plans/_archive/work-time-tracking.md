# Перестройка учёта рабочего времени клиента (Онлайн + Активно)

**Статус:** в работе (ветка `feat/work-time-tracking`). Утверждён владельцем 2026-06-20.

## Context

В «Сводном отчёте по клиентам» колонка **«Онлайн» врёт**: сразу после запуска показывает «10 ч 00 мин». Корень (`backend-api/src/services/statisticsAuditService.ts` → `recomputeDailySummary`): онлайн считается из событий `app.session.start/stop` в захардкоженном окне 08:00–18:00 МСК; для **незакрытой** сессии без активности конец берётся как 18:00 → `18:00 − 08:00 = ровно 10ч`. Открытая сессия растягивается до конца рабочего окна, а не до «сейчас / последний раз жив». `cutoffHour` игнорируется расчётом, стоит искусственный кап 10ч.

Владелец просит перестроить по лучшим практикам, легко (не нагружать клиент/сервер), и показывать **две** метрики: **«Онлайн»** (программа открыта и жива) + **«Активно»** (реально за работой, без простоя).

## Что переиспользуем (нулевая новая нагрузка)

- **Heartbeat 60с уже есть:** `startClientSettingsPolling`/`applyRemoteClientSettings` → `GET /client/settings?...&username=` → `touchClientSettings` пишет `client_settings.lastSeenAt`+`lastUsername`. Active-ms поедет доп. query-параметром на этом же пинге.
- **audit-события** (`statistics_audit_events`) дают `app.session.start/stop` и счётчики Создано/Изменено/Удалено.

## Дизайн

### A. «Онлайн» = connected time, ограниченный heartbeat'ом (только сервер)
Ядро вынесено в чистую `sessionizeOnlineMs(events, { windowStart, windowEnd, lastSeenAt, graceMs })`:
- Окно: `[startOfDay(00:00), min(now, dayAtHour(cutoffHour))]` — уважать cutoffHour, убрать хардкод 08–18.
- Сессионизация `app.session.start/stop`. Закрытая: `[start, min(stop, windowEnd)]`. Открытая: конец = `min(windowEnd, lastSeenAt(login)+graceMs)`, `lastSeenAt(login)` = max `client_settings.lastSeenAt` по `lastUsername=login`, `graceMs ≈ 2 мин`. Кап 10ч убран (safety 24ч).
- Только что открыл → ~0 (windowEnd=now); завис без stop → кончается на последнем пинге.

### B. «Активно» = active time по вводу
- Renderer `activityTracker`: пассивные `pointerdown/keydown/wheel/visibilitychange` → `lastInputAt`. Тик 30с: если `now−lastInputAt < IDLE_THRESHOLD` (5 мин) и вкладка видима → +30с к `activeMsToday` (сброс в локальную полночь).
- IPC `activity:report {activeDate, activeMs}` → main держит последнее → heartbeat добавляет `&activeMs=&activeDate=`.
- Backend: `clientSettings` роут → `recordClientActiveTime` upsert в `statistics_active_time (summary_date, client_id, login, active_ms, updated_at)`, `active_ms = GREATEST(existing, reported)`. Серверная таблица, не в sync-registry.
- recompute суммирует `active_ms` по login → колонка `activeMs` в `statistics_audit_daily`.

### C. Отчёт
- `SuperadminAuditPage.tsx`: колонка «Активно» + заголовок «(HH:00)» из `cutoffHour`.

## Этапы
1. **«Онлайн»-фикс (только сервер)** + юнит-тест — сразу убирает баг.
2. **«Активно»-конвейер**: миграция → backend → клиент → UI.

## Verification
- Юнит-тесты `sessionizeOnlineMs` (открытая без активности → НЕ 10ч; lastSeen-bound; cutoff) + ядро трекера.
- `pnpm -r typecheck/lint` + backend test.
- CDP-smoke: отчёт ~0 «Онлайн»; «Активно» растёт на вводе, стоит в простое.
- Перф: новых запросов нет; tracker = пассивные слушатели + 1 таймер.
