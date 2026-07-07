# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.
>
> Если работы в потоке нет — `Status: IDLE` и пустые секции. Команда `/start` это увидит и не будет ничего навязывать.

**Status:** IDLE (прод-инцидент CPU разобран и закрыт хот-деплоем #110; активной нитки нет)
**Updated:** 2026-07-07 (Claude Opus 4.8, машина `PC40`)
**Branch:** `main` (= origin/main = `d99a6f66`). Дерево чистое, stash пуст, открытых PR нет, локальная только `main`.
**Last deployed:** **#110 `10022b3c` на проде** (2026-07-07, backend-only hot-deploy, БЕЗ версии/тега/пересборки клиента) поверх релиза **v2026.707.1412**. `/health` = 2026.707.1412, оба сервиса active, `/updates/status.latest` = 2026.707.1412. **Миграций нет.**

## Текущая нитка

_n/a_ — сессия 2026-07-07 разобрала **прод-инцидент CPU** (жалоба владельца: клиентов зависает и выкидывает в релогин, обрывы с базой). Диагноз (read-only probe прода): `user_presence`-хартбиты писались в durable-зашифрованный fanned-out ledger (`/presence/me` раз в 60с × клиент + `touchPresence` при отправке чата), presence ~⅔ всех записей ledger → голова ledger постоянно двигалась → все клиенты постоянно re-pull/re-decrypt перекрывающихся окон `/ledger/state/changes` на главном JS-потоке (O(N²)) → оба backend ~50% CPU, таймауты, зависания. Фикс **#110**: presence только в таблицу `userPresence` (онлайн-статус в chat/notes + self-ping цел), в ledger не пишется; защитный фильтр в `writeSyncChanges` (инвариант) + регресс-тест `presenceNotLedgered.test.ts`. Задеплоено backend-only, **прод-verify**: presence-запись в ledger 9/мин→**0**, load 1.5→0.57, CPU обоих процессов ↓.

## Следующий шаг

**Активной нитки нет — выбрать из бэклога.** Кандидаты (сверено с PENDING на 2026-07-07):
- **Ещё тише клиент↔сервер** (PENDING 🟢, follow-up этого инцидента): увеличить интервалы поллинга `/ledger/state/changes` / хартбита `/presence/me` — меньше запросов к прод-серверу. Опционально, размен на свежесть.
- **Группы марок — группировка списка по секциям** (PENDING 🟢): фильтр по группе есть, идея — секции строк.
- **Опциональные хвосты редизайна спецификации** (PENDING 🟢): backfill легаси `variantGroup`; Фаза 3 — подстановка вариантов в прогнозе.
- **Решения владельца:** forward-proxy VPS для AI (🔴 блокер, Anthropic режет РФ-IP).
- Прочее открытое — в [`PENDING_FOLLOWUPS.md`](PENDING_FOLLOWUPS.md).

## Контекст

- Прод: **v2026.707.1412** + хот-фикс `10022b3c` (backend-only), оба сервиса active. Сессия трогала прод: read-only диагностика (psql/logs/top) + деплой фикса (git pull `189a365d→10022b3c` в `/home/valstan/MatricaRMZ`, build `@matricarmz/backend-api` — prebuild подтянул ledger, install пропущен (lockfile не менялся), рестарт обоих сервисов). **Миграций/backfill нет.** Обратимо (редеплой прежнего).
- PR сессии: **#110** (фикс, `10022b3c`) + **#111** (доки: GOTCHAS M28, COMPLETED §Инфра, handoff, to-brain) — оба смержены squash, ветки удалены.
- Ключевые файлы фикса: [`backend-api/src/routes/presence.ts`](../backend-api/src/routes/presence.ts), [`backend-api/src/routes/chat.ts`](../backend-api/src/routes/chat.ts) (`touchPresence`), [`backend-api/src/services/sync/syncWriteService.ts`](../backend-api/src/services/sync/syncWriteService.ts) (`writeSyncChanges` — фильтр presence).
- Грабля зафиксирована: [`GOTCHAS.md`](GOTCHAS.md) **M28** (presence в durable-ledger → O(N²) CPU). Заметка в brain: [`mailbox/to-brain/2026-07-07-ephemeral-data-not-in-durable-fanout-ledger.md`](../mailbox/to-brain/2026-07-07-ephemeral-data-not-in-durable-fanout-ledger.md).
- Прод-репо — **/home/valstan/MatricaRMZ** (backend из `backend-api/dist/index.js` → build серверных пакетов обязателен). Updates dir — `/opt/matricarmz/updates/`.
- **PG created_at в `ledger_tx_index`/`change_log` — bigint epoch-ms**, не timestamp (для probe-запросов: `where created_at > (extract(epoch from now())*1000)::bigint - N`). `change_log` — легаси (последняя запись ~февраль), живой ledger — `ledger_tx_index`.

## Открытые вопросы для пользователя

- Нет.

## Не забыть (low-priority)

1. **Понаблюдать за клиентами** после фикса #110: зависаний/релогинов из-за перегрузки backend быть не должно; CPU обоих процессов продолжит оседать по мере завершения пост-рестартового догона. Если где-то ещё подвисает — прицельная диагностика.
2. Ledger release-token — следующая ротация до ~2026-08-04 (PENDING ⏳).
3. Ротация SSH-ключей прода — до 2026-08-21 (PROJECT_STATE).
4. AV-ложнопозитивы watchdog'а — поглядывать в «Критические события».
5. Мастера жмут «Выдать в работу» на ремнарядах, иначе прогноз по ремонту пуст (операционный, передать мастерам).
6. Спот-чек владельцем после обновления клиентов до v2026.707.1412: группы марок, фильтр списка марок, «Возврат из сборки» (#103), тёплая тема (#102).
