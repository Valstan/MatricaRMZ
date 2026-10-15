# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE (нитка «Кладовщик» фаза 2: PR-1 готов, ждёт CI/мерж)
**Updated:** 2026-10-15 (dev-сессия, машина `PC79`)
**Branch:** `feat/ppe-phase2-pr1-contract-core` (от main 905110b5)
**Last released version:** **v3.78.0** на проде (+ android-v3.78.0).

## Текущая нитка

Фаза 2 «Кладовщика» (`docs/plans/ppe-kladovshik-phase2.md`). PR-1 готов в ветке:
контракт 6 таблиц (tables/registry/dto/ledger/ownership=server/requirement) +
обновлённые ряды наборов/выдач + паблишер в порядке плана + ядро
(условия, `shiftByAbsences`, `resolveGroupNorms`) + тесты. Гейты локально зелёные
(typecheck/lint/checkSyncContract; полный `-r test` exit 0 — 1701 electron,
1166 backend, 83 shared; `clientOpsArchive` в этот раз зелёный и в пакете).
Следующий шаг после мержа: PR-2 (сервис+REST: отпуска, группы, импорт preview/apply;
перед ним показать владельцу список колонок ЗУП §4 на утверждение — риск 1).

## Следующий шаг

Открыть PR ветки `feat/ppe-phase2-pr1-contract-core`, дождаться CI, squash-merge.

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
