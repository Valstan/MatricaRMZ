# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.
>
> Если работы в потоке нет — `Status: IDLE` и пустые секции. Команда `/start` это увидит и не будет ничего навязывать.

**Status:** ACTIVE (work-order rework Phases 0-3 в `main`, **не выпущены**; развилка — релиз vs write-block follow-up)
**Updated:** 2026-07-01 (Claude Opus 4.8, машина `rmz4val`)
**Branch:** `main` (= origin/main, `12588a3c`). Дерево чистое, stash пуст, открытых PR нет, локальная только `main`.
**Last released version:** **v2026.630.1141 на проде.** Work-order Phases 0-2 (#4–#6) **и** Phase 3 ролевая изоляция (#9) — **в `main`, НЕ на проде.**

## Текущая нитка

**Эпик «доработка нарядов + ролевая изоляция Рамзии»** — план [`docs/plans/work-order-rework-2026-06.md`](plans/work-order-rework-2026-06.md). За эту сессию **Phase 3 (ролевая изоляция) собрана, верифицирована dual-role и смержена** (#9, `12588a3c`). Phases 0-2 были смержены ранее (#4–#6, машина PC40).

**Phase 3 — что сделано (security-ядро, всё в #9):** серверный read-гейт нарядов владельца `ramzia` (видны только ей, `glavbux`-read, superadmin) на 3 sync-поверхностях + reports-билдере + AI `get_operations`; pre-sync purge уже-утёкших копий; restricted-config по login. 3 реальные утечки найдены и закрыты в ходе верификации (C1 AI-tool, deleted-payload тумбстоун, M1 case-sensitivity). Подробности — план §Прогресс (2026-07-01) и тело PR #9.

## Следующий шаг

Развилка (решает владелец):
1. **Выпустить релиз** (`/reliz`) — на проде ждут: work-order Phases 0-2 (UI: даты/фильтр типа/кнопка «выполнен») + Phase 3 изоляция. ⚠️ Менялся `backend-api` (sync-гейт/reports/purge/claudeTools) → на проде **нужна пересборка серверных пакетов** (`shared`+`backend-api`+`web-admin`), **НЕ** renderer-only. **Миграций БД нет** (новых `drizzle/*.sql` в диапазоне нет). После релиза: записать PROGRAM_EFFECTS-строку «на проде с vX.Y.Z», обновить COMPLETED.
2. **Write-block follow-up** (отложенный хвост Phase 3) — read-allowlist (`glavbux`) сейчас наряды Рамзии **видит**, но технически может *запушить правку*; директива даёт ей «r». Нужен push-guard в [`ledgerAuthzGuard.ts`](../backend-api/src/services/sync/ledgerAuthzGuard.ts) по owner+allowlist. Радиус — write-путь. См. PENDING §🟡.

Рекомендация: сперва **релиз** (накопленная функциональность + security-изоляция на прод), затем write-block свежей сессией.

## Контекст

- **План эпика:** [`docs/plans/work-order-rework-2026-06.md`](plans/work-order-rework-2026-06.md) — §Прогресс: ✅ Phases 0-2 + Phase 3 (3a–3g). Открытое — write-block, single-tx атомарность, со-локация даты+кнопки.
- **Связанные коммиты:** #9 `12588a3c` (Phase 3, squash из 7 коммитов ветки `feat/wo-ramzia-isolation-sync-gate`).
- **Прод:** v2026.630.1141, оба сервиса active. Phases 0-3 на прод **не уезжали**.
- **Открытых PR:** нет. **Stash:** пуст. **Локальные ветки:** только `main`. **Un-pushed:** нет.
- **Dual-role verify-рецепт** (как повторить на этом компе) — [`docs/machines/rmz4val.md`](machines/rmz4val.md) §«Dual-role CDP verify». Артефакты прогона (gitignored) — `.verifier-electron/iso-list-*.png`, `_iso-cdp.mjs`.
- **Brain:** отправлено письмо о переносимом паттерне row-level sync-изоляции — [`mailbox/to-brain/2026-07-01-row-level-sync-isolation.md`](../mailbox/to-brain/2026-07-01-row-level-sync-isolation.md).

## Открытые вопросы для пользователя

- **Релиз сейчас или write-block follow-up?** Накопленная работа (Phases 0-3) ждёт выпуска на прод.

## Не забыть (low-priority)

1. **При релизе этих ниток:** backend менялся (Phase 3) → серверная пересборка обязательна (`-F shared -F backend-api -F web-admin build`), не renderer-only (memory `renderer-only-release-skips-prod-build` тут НЕ применима). Миграций нет.
2. **Локальная dev-БД `matricarmz_probe`** (прод-снапшот) — у `ramzia`/`glavbux`/`nastya_spec` локально выставлен dev-пароль `verify123` (прямой SQL для dual-role verify). Безвредно (локально), но знать при будущих прогонах.
3. **Отложенное Phase 3:** write-block read-allowlist (PENDING 🟡); + прежние хвосты эпика (single-tx атомарность проводки; со-локация даты завершения + кнопки «выполнен» в карточке).
