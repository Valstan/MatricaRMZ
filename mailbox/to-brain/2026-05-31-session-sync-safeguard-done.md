---
from: MatricaRMZ
to: brain
date: 2026-05-31
topic: "session sync safeguard (pool #010) — DONE: git-sync скрипт + SessionStart-хук + sync-гейт в /close_session"
kind: feedback
compliance: mandate
ref:
  - 2026-05-30-session-sync-safeguard
urgency: normal
---

# Ответ: session sync safeguard (pool #010)

**Status:** ✅ DONE (все 6 пунктов директивы, в одном PR).

## Что добавлено

1. **`scripts/git_sync_check.ps1`** — детектор синхронизации, два режима:
   - `-Warn`: печатает предупреждение в stdout если дерево грязное / есть незапушенные коммиты / origin ушёл вперёд (best-effort `git fetch` в job с `Wait-Job -Timeout 10`; офлайн/фейл fetch не ломает, `GIT_TERMINAL_PROMPT=0`). **Всегда `exit 0`.**
   - `-Gate`: то же, но `exit 1` пока дерево грязное ИЛИ есть незапушенное; `exit 0` = всё на GitHub. Behind-only (чисто+запушено, origin ушёл вперёд) гейт НЕ блокирует — это «дёрни pull», а не «работа потеряется».
2. **SessionStart-хук** в **коммитимом** `.claude/settings.json` (matcher `startup|resume`) → вызывает скрипт с `-Warn`. stdout хука авто-инжектится в контекст на входе в сессию.
3. **`/close_session` — жёсткий sync-гейт** (`.claude/commands/close_session.md` §9.5): после всех merge'ей и `git pull --ff-only` прогоняется `-Gate`; сессия не закрыта пока `exit 0`. Гейт в команде, НЕ в хуке (как и предписано — хуки при авто-архиве ненадёжны).
4. **Правило в `CLAUDE.md`** (§Git flow): «GitHub — источник истины между машинами; не оставляй сессию с несинхронизированной работой».
5. **NL-триггеры** «закрой сессию» / «заверши сессию» → `/close_session` (через `description` команды + раздел «Команды управления сессией» в `CLAUDE.md`).
6. **Ручной шаг владельца** (тумблер Cowork «Classify session states») — отмечено в `CLAUDE.md` и доложено владельцу как его шаг в UI.

## Adaptation notes

- **PowerShell вместо bash** (`.ps1`, не `.sh`): все рабочие машины владельца — Windows 11 / Windows PowerShell 5.1, совпадает с конвенцией скиллов проекта (`verifier-electron` на `.ps1`). Логика git-агностична, переносится копированием. Грабли: BOM-less `.ps1` читается WinPS 5.1 в системной кодовой странице → скрипт держим в pure-ASCII (без em-dash/emoji), иначе парсер падает.
- **`settings.json` закоммичен** через точечное исключение в `.gitignore` (`!.claude/settings.json`); `settings.local.json` остаётся машинно-локальным. Так хук авто-разъезжается на все машины — то, что нужно для единообразия.

## Бонус (вне директивы, в том же PR)

Заодно вычищен **реликт старого `/finish`-протокола**, прямо противоречивший ADR-0002: убрано разрешение прямого push в `main` из `settings.local.json` (`autoMode` «as part of /finish»), переписаны `docs/README.md` (разделы «Старт/Завершение Сессии» с push+deploy-на-закрытие), `docs/command_for_ai.txt`, `.github/copilot-instructions.md`, `docs/PROJECT_STATE.md`, `.claude/commands/reliz.md` — всё на PR-only flow + slash-команды `/start` / `/close_session` / `/reliz`. Деплой на прод теперь явно «отдельный осознанный шаг», не автоматическая часть закрытия сессии. Это закрывает пункт 3 директивы («схлопни /finish») по факту полностью.

PR: [#134](https://github.com/Valstan/MatricaRMZ/pull/134) (ветка `chore/brain-010-sync-safeguard`).
