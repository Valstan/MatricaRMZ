# Session Handoff

> Sticky-note для непрерывности: куда шла нитка, что дальше. История — в `git log`, открытое — в `docs/PENDING_FOLLOWUPS.md`, сделанное — в `docs/COMPLETED.md`. Только активное: старые нитки вычищены (правило раскола «открытое vs сделанное»).

**Status:** ACTIVE (нитка «Кладовщик» фаза 2: PR-0 готов, ждёт PR)
**Updated:** 2026-10-15 (dev-сессия, машина `PC79`)
**Branch:** `feat/ppe-phase2-pr0-schema` (от main 03d3ba54)
**Last released version:** **v3.78.0** на проде (+ android-v3.78.0).

## Текущая нитка

Фаза 2 «Кладовщика» (`docs/plans/ppe-kladovshik-phase2.md`, скоуп утверждён
владельцем 2026-10-12). PR-0 (схема `0110` + журнал idx 109 + `schema.ts` обеих
сторон + реплика `0035` + паритет ×3 + guard-тесты + NULL-чинки `documentId`)
готов в ветке, гейты зелёные (typecheck/lint/checkSyncContract; тесты 1700/1701 —
единственный красный `clientOpsArchive` висит и на чистом main, 7za `-mcu=on`
виснет на этой машине, не регресс). Отклонения от плана: номера `0110`/`0035`
(0108–0109/0034 заняты), индекс `ppe_collectives_department_idx` сверх плана.
Следующий шаг после мержа: PR-1 (контракт + паблишер + ядро).

## Следующий шаг

Открыть PR ветки `feat/ppe-phase2-pr0-schema`, дождаться CI, squash-merge.

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
