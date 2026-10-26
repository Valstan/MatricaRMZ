# Phase 3.8 — вариант B (offline-specs) — отложено 🗓 since:2026-06-18

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟢 Отложенные фазы / route /zavod»

Scope A на проде (v2026.618.117). **Вариант B (НЕ делаем без явной потребности):** завести `directory_parts` в синк-реестр + клиент читает спеки из синканного SQLite + снести code/name-зеркало. Разворот рабочего live-HTTP + расширение sync-протокола (риск массовой порчи). Только если понадобится offline-доступ к спекам. Фундамент: [`plans/_archive/parts-nomenclature-phase3-8.md`](plans/_archive/parts-nomenclature-phase3-8.md).
