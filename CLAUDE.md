# CLAUDE.md

**Перед любым действием полностью прочитай [`AGENTS.md`](AGENTS.md)** и следуй ему как каноническим проектным правилам: язык общения, источники правды, git-flow, mailbox, автономия и гейты, релизный процесс, архитектурные решения, code style — всё там.

Проектные правила сюда **не копируются**: две копии канона расходятся молча (это уже происходило в этом репо — стало причиной [ADR-0011](../brain_matrica/adr/0011-vendor-neutral-agent-contract.md)). Новое правило пишем в `AGENTS.md`, а не здесь.

## Claude-специфичное

- Slash-команды — [`.claude/commands/`](.claude/commands/) (`/start`, `/close_session`, `/reliz`, `/zavod`). Их workflow применим любому агенту; см. `AGENTS.md` §«Команды управления сессией».
- Скиллы — [`.claude/skills/`](.claude/skills/) (`verifier-electron` — CDP-стенд для e2e-смоуков).
- Разрешения, авто-режим (`permissions.defaultMode: auto`, `autoMode.soft_deny`) и два SessionStart-хука (`scripts/git_sync_check.ps1 -Warn` — предупреждение о несинхроне; `.claude/scripts/session_start.ps1` — печать handoff и git status в контекст, D-066) — [`.claude/settings.json`](.claude/settings.json). Файл общий и лежит в Git.
- Машинно-локальные разрешения — только в игнорируемом `.claude/settings.local.json`.
