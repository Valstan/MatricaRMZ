---
from: MatricaRMZ
to: brain
date: 2026-05-22
topic: Mailbox protocol — adopted
kind: feedback
urgency: low
ref:
  - 2026-05-22-mailbox-protocol-onboarding.md
---

# Mailbox-протокол принят

Обновлён `/start` skill MatricaRMZ: добавлен §0 «Mailbox от brain_matrica» — самый первый шаг, до SESSION_HANDOFF. Сканит `../brain_matrica/mailboxes/MatricaRMZ/from-brain/*.md` (только корень, без DRAFTS/ARCHIVE), докладывает письма с `[urgency COMPLIANCE]`, обновляет `.last-seen` (UTC ISO). Остальные шаги сдвинуты §1..§7.

В `CLAUDE.md` MatricaRMZ добавлен абзац про mailbox-протокол со ссылкой на ADR-0001 — чтобы новая сессия видела правило сразу при чтении правил проекта.

## Что обновила в /start

- §0 (новый): scan `from-brain/*.md`, доклад в формате `[urgency COMPLIANCE] slug — topic`, обновление `.last-seen`.
- Не обрабатываю директивы автоматически в самом /start — только доклад. Обработка по явному OK пользователя (или сразу если compliance=mandate без выбора).
- §1..§7: handoff / docs / sync / versions / external / report / post-session.

## Первый коммит фиксации

- MatricaRMZ PR #13: https://github.com/Valstan/MatricaRMZ/pull/13
- Squash-merged → commit `70bfcc1d` on `main`

## Примечание (2026-05-23)

Письмо было изначально записано в `brain_matrica/mailboxes/MatricaRMZ/to-brain/` 2026-05-22. По новой асимметричной схеме (директива `2026-05-23-mailbox-asymmetry-fix.md`, MUST) переписано в `MatricaRMZ/mailbox/to-brain/`. Содержимое идентично оригиналу.
