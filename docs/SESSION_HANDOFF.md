# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** IDLE (релиз v3.78.0 на проде, приёмка зелёная, всё смержено и запушено)
**Updated:** 2026-10-15 (reliz session, машина `Computer`)
**Branch:** main = origin/main
**Last released version:** **v3.78.0** на проде (+ android-v3.78.0).

## Текущая нитка

_n/a_ — сессия выпустила релиз v3.78.0 и закрыта:
- PR #1351 (нитка «Сейчас на заводе»: точные срезы, merged-отчёт, кнопка меню,
  Карта этапов) + живой смоук 29/29;
- релизный PR #1353 (VERSION + welcome 2026-10-15 + COMPLETED + PROGRAM_EFFECTS);
- теги `v3.78.0` + `android-v3.78.0`, обе CI-сборки зелёные;
- прод: pull → артефакты (exe/yml/blockmap + APK) → latest.json согласен →
  леджер подписан → `deploy-backend.sh` (откат-копия `.deploy-backup/20261015-020435`) →
  приёмка: :3001/:3002 — 3.78.0 порознь, `/updates/status` latest 3.78.0 +
  `lastError: null`, blockmap 200, диспетчер ведёт Android 3.77.0 → 3.78.0.
  Миграций не было (code-only).

## Следующий шаг

По слову владельца. Кандидаты — в открытых вопросах ниже.

## Контекст

- В `node_modules` — Electron-ABI (`install-app-deps` под смоук): перед `vitest`
  electron-app сначала `corepack pnpm rebuild better-sqlite3`.
- SSH-канал с этого компа виснет после вывода: вывод достоверен, «timed out» ≠
  «не выполнено»; состояние проверять повторным чтением, инлайн с `$(...)` и `%{}`
  в двойных кавычках PowerShell раскрывает сам — сложные проверки слать файлом-скриптом.
- NUL-guard shared и engineStrictView-таймаут на этой машине — скорость диска,
  не правки (на CI зелёные).

## Открытые вопросы для пользователя

- Ранг `disassembly_defect = 30` на проде (вместо 20) — править только с явного слова.
- Путь обновлений в AGENTS.md (`/opt/matricaRMZ/`) vs факт (`/opt/matricarmz/`).
- Ротация SSH PC79 ≤ 2026-11-26 (календарь PENDING).
- M102 dry-run/apply — ждёт окна владельца.
- Пилот узла PC79 — ручной ход владельца.
- DeepSeek 402 (пополнить).
- Yandex-зеркало 3.75.0 без blockmap (PENDING 🟡).
- Ответ Мозга про лёгкий token для serve (письмо `2026-10-13-opencode-serve-auth-answer` уже отвечает — сверить).
