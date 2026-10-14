# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE (релиз v3.78.0 — PR открыт, дальше merge → теги → прод)
**Updated:** 2026-10-15 (reliz session, машина `Computer`)
**Branch:** release/v3.78.0 (план `docs/plans/now-at-plant-filters-2026-10.md` закрыт кодом в #1351)
**Last released version:** **v3.77.0** на проде (+ android-v3.77.0).

## Текущая нитка

Релиз v3.78.0 (code-only: merged-отчёт «Сейчас на заводе», точные срезы, «Где сейчас?»,
«Карта этапов» — всё из #1351). Миграций нет, backfill нет, гейта #025 нет.
Дефолт pre-release: `VERSION` + `package.json` → 3.78.0, welcome-запись с датой
2026-10-15, COMPLETED + PROGRAM_EFFECTS в этом же PR.

## Следующий шаг

1. Зелёные гейты PR → merge → `main` pull → теги `v3.78.0` + `android-v3.78.0` → push тегов.
2. Дождаться сборок (installer + APK), APK — локально + `scp` на прод.
3. Прод: `git pull --ff-only` → артефакты (exe/yml/blockmap локально + `scp`, latest.json сверить) → `release:ledger-publish 3.78.0` → `deploy-backend.sh` → приёмка по :3001/:3002 + `/updates/status` + blockmap 200 + диспетчер Android.
4. Sync-гейт, финальный отчёт, handoff в IDLE.

## Открытые вопросы для пользователя

- Ранг `disassembly_defect = 30` на проде (вместо 20) — править только с явного слова.
- Путь обновлений в AGENTS.md (`/opt/matricaRMZ/`) vs факт (`/opt/matricarmz/`).
- Ротация SSH PC79 ≤ 2026-11-26 (календарь PENDING).
- M102 dry-run/apply — ждёт окна владельца.
- Пилот узла PC79 — ручной ход владельца.
- DeepSeek 402 (пополнить).
- Yandex-зеркало 3.75.0 без blockmap (PENDING 🟡).
- Ответ Мозга про лёгкий token для serve (письмо `2026-10-13-opencode-serve-auth-answer` уже отвечает — сверить).
