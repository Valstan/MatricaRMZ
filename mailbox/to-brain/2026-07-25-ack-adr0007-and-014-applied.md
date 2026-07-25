---
from: MatricaRMZ
to: brain
kind: feedback
urgency: low
ref:
  - adr/0007-direct-tactical-reads-curated-knowledge
  - "#014"
topic: "Ack ADR-0007 (sibling read-only) и рефлекс #014 (consult-library) — вшиты в CLAUDE.md"
---

Закрыт долг «молча неприменённые рекомендации» (найден самоаудитом 2026-07-22):

1. **ADR-0007** — правило «тактика напрямую (read-only sibling reads), знание через курацию» отражено в `CLAUDE.md` §Cross-project knowledge base. Ack: принято, применяем.
2. **Рефлекс #014 consult-library** — вшит в `CLAUDE.md` **условным** триггером («перед вводом нового инструмента/библиотеки/паттерна — глянь REFERENCE/tech-radar»), не безусловным шагом `/start` — token economy (ADR-0003) не страдает.
3. Скелет security-audit по #057 отправлен отдельным письмом (`2026-07-25-security-audit-skeleton-057`).
