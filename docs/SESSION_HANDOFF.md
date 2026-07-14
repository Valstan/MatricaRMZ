# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.
>
> Если работы в потоке нет — `Status: IDLE` и пустые секции. Команда `/start` это увидит и не будет ничего навязывать.

**Status:** IDLE (пилот UI-конструктора отгружен релизом; активной длинной нитки нет)
**Updated:** 2026-07-15 (Claude Opus 4.8, машина `rmz4val`)
**Branch:** `main` (= origin/main). Дерево чистое, stash пуст, открытых PR нет.
**Last released version:** **v2026.715.45 на проде** (выпущена в этой сессии; пилот UI-конструктора «Мои экраны»). Оба сервиса active, `/health` = 2026.715.45, `/updates/status` latest = 2026.715.45, blockmap 200.

## Текущая нитка

Активной длинной нитки нет. Сессия отработала **пилот UI-конструктора** (уровень 1, без нейронки) — 3 PR ([#210](https://github.com/Valstan/MatricaRMZ/pull/210)/[#211](https://github.com/Valstan/MatricaRMZ/pull/211)/[#212](https://github.com/Valstan/MatricaRMZ/pull/212)), CDP-смоук 15/15, **выпущен релизом v2026.715.45**. Плюс применён мандат brain по автономному `/reliz` ([#214](https://github.com/Valstan/MatricaRMZ/pull/214)).

## Следующий шаг

Выбор владельца в начале следующей сессии:

1. **UI-конструктор — обкатка пилота.** Собрать вживую первый дашборд-навигатор, собрать обратную связь операторов. Уровень 2 (нейронка описывает экран) отложен до доказанной потребности (упирается и в гео-блок Anthropic).
2. **H7 шаг «в» — fail-closed `normalizeRole`** (безопасен: живых `user`=0). Флип [`employeeAuthService.ts:265`](../backend-api/src/services/employeeAuthService.ts) `return 'user'` → fail-closed. ⚠️ Не 1 строка: задевает `roleReport` + тесты — отдельный PR. Детали — [`PENDING_FOLLOWUPS.md`](PENDING_FOLLOWUPS.md) §Security.
3. **Ф2 де-дупа `blank-synthetic-codes`** (владелец дал добро «делать как раскатано»). Гейт: недавние клиенты ≥ 2026.712.1818. Детали — [`plans/parts-nomenclature-deep-dedup-2026-07.md`](plans/parts-nomenclature-deep-dedup-2026-07.md) §Ф2.

## Контекст

- **Отгружено в этой сессии (2026-07-15):** пилот UI-конструктора → **релиз v2026.715.45 на проде**.
  - `shared/uiSpec.ts` (спек экрана + tolerant parse), `SpecRenderer` + intent runtime, 2 read-only виджета.
  - EAV-тип `ui_screen` (общезаводской sync, без DDL), свой IPC-домен `uiScreens:*` (в обход `masterdata.edit`), права по section access.
  - Редактор (dnd-kit) + «Мои экраны» в меню (группа «Мой круг»).
  - CDP-смоук `_smoke-ui-builder.mjs` (gitignored) — 15/15.
- Мандат brain `2026-07-15-reliz-autonomous-close-fusion` применён (#214): автономный `/reliz` + fusion с закрытием сессии + slim `/close_session` + allowlist + `/start §5.5`. ack в `mailbox/to-brain/`.
- Прод: v2026.715.45, оба сервиса active. Миграций/backfill релиз не вёз (renderer + клиентский EAV-seed).
- Открытых PR: нет. Un-pushed веток: нет. Stash пуст.

## Открытые вопросы для пользователя

- **UI-конструктор** — обкатывать пилот дальше или переключиться на H7/Ф2? (по выбору владельца)
- **AI/VPS** — отложено владельцем на неопределённый срок; PENDING 🔴 остаётся, не поднимать.

## Не забыть (low-priority)

1. **H7 шаг «в»** — безопасен (живых `user` нет), но не 1 строка (тесты `roleReport`); отдельный PR.
2. **Ф2 гейт** — не гнать apply, пока не все недавние клиенты ≥ 2026.712.1818; env сорсить (M30); после apply — M31-верификация PG.
3. Ledger release-token — ротация до ~2026-08-04 (первый релиз после ~2026-08-01 упадёт 401, лечение — PENDING ⏳).
4. Ротация SSH-ключей прода — до 2026-08-21.
5. Мастера жмут «Выдать в работу» на ремнарядах, иначе прогноз по ремонту пуст.
6. deadcode-прогон (месячная дельта) — ~2026-08-04.
7. Паразитный `~/MatricaRMZ/backend-api/ledger` на проде — удалить при случае.
