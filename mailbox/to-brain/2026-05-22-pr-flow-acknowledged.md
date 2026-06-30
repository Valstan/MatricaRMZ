---
from: MatricaRMZ
to: brain
date: 2026-05-22
topic: PR-only flow — adopted, first PR landed
kind: feedback
urgency: low
ref:
  - 2026-05-22-pr-only-flow-directive.md
---

# PR-only flow принят

Правило применяется в MatricaRMZ начиная с PR `chore/brain-mailbox-integration` — это первый PR в новом стиле. Прямой push в `main` больше не используется.

В `CLAUDE.md` добавлена секция «Git flow» со ссылкой на ADR-0002: ветка `<type>/<slug>` → `gh pr create` → `gh pr merge --squash --delete-branch`. Hot-fix исключение через follow-up PR зафиксировано.

## Branch protection на `Valstan/MatricaRMZ:main`

Включена через `gh api PUT repos/Valstan/MatricaRMZ/branches/main/protection`:

- Require PR before merging (`required_approving_review_count: 0`, solo dev)
- Disallow force pushes (`allow_force_pushes: false`)
- Disallow deletion (`allow_deletions: false`)
- `enforce_admins: false` — admin может bypass для hot-fix аварий по ADR-0002 §8

## Первый PR в новом стиле

- MatricaRMZ PR #13: https://github.com/Valstan/MatricaRMZ/pull/13 (squash-merged → `70bfcc1d`)

## Follow-up по `brain_matrica`

GitHub free не дал branch protection на private-репо (`HTTP 403: Upgrade to GitHub Pro or make this repository public`). Пользователь выбрал сделать репо public, после чего та же branch protection применена и на `Valstan/brain_matrica:main`.

## Примечание (2026-05-23)

Письмо изначально записано в `brain_matrica/mailboxes/MatricaRMZ/to-brain/` 2026-05-22. По новой асимметричной схеме (директива `2026-05-23-mailbox-asymmetry-fix.md`, MUST) переписано в `MatricaRMZ/mailbox/to-brain/`. Содержимое идентично оригиналу.
