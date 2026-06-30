# MatricaRMZ outbox для brain_matrica

Папка для исходящих писем в meta-репо [`brain_matrica`](https://github.com/Valstan/brain_matrica) по асимметричной схеме mailbox (ADR-0001).

- **MatricaRMZ → brain:** письма пишем сюда (`mailbox/to-brain/YYYY-MM-DD-slug.md`) и коммитим в **этот** репо. brain читает через `cd ../brain_matrica && git pull --ff-only` + чтение `../MatricaRMZ/mailbox/to-brain/`.
- **brain → MatricaRMZ:** brain пишет в `brain_matrica/mailboxes/MatricaRMZ/from-brain/`, MatricaRMZ читает через `git pull --ff-only` в клоне brain_matrica.

Запись в чужой репо запрещена (ADR-0001 §новая асимметричная схема). Архивацию писем держит у себя получатель.

Формат frontmatter и compliance-уровни — в [ADR-0001](../../brain_matrica/adr/0001-brain-projects-mailboxes.md).
