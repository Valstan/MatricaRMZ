# MatricaRMZ outbox для brain_matrica

Папка для исходящих писем в meta-репо [`brain_matrica`](https://github.com/Valstan/brain_matrica) по асимметричной схеме mailbox (ADR-0001).

- **MatricaRMZ → brain:** письма пишем сюда (`mailbox/to-brain/YYYY-MM-DD-slug.md`) и коммитим в **этот** репо. brain читает через `git pull --ff-only` MatricaRMZ.
- **brain → MatricaRMZ:** brain пишет в `brain_matrica/mailboxes/MatricaRMZ/from-brain/`, MatricaRMZ читает **двухканально без синхронизации чужого репо** (мандат владельца 2026-08-04): локально (как есть, без `pull`) + GitHub API/веб `main` того же проекта (без clone/fetch/pull). Детали и правило свежести — в `.claude/commands/start.md` §0.

Запись в чужой репо запрещена (ADR-0001 §новая асимметричная схема), как и `fetch`/`pull`/`checkout` в нём. Архивацию писем держит у себя получатель.

Формат frontmatter и compliance-уровни — в [ADR-0001](../../brain_matrica/adr/0001-brain-projects-mailboxes.md).
