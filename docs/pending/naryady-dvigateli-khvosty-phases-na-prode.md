# Наряды/двигатели — хвосты (Phases на проде) 🗓 since:2026-06-30

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟢 Отложенные фазы / route /zavod»

План: [`plans/_archive/work-order-rework-2026-06.md`](plans/_archive/work-order-rework-2026-06.md). Всё основное на проде (изоляция закрытых нарядов, display-filter модель, грифы). Открыто:
- 🟡 **Атомарность проводки сборки — отложено:** идемпотентность есть (guard'ы `op.status='closed'`/`doc.status='posted'`) → двойного списания нет. Открыто: single-tx обёртка release→post→close (узкая дыра post-после-release при сбое). Полная обёртка = рефактор shared warehouse-posting, marginal-value низкий.
- 🟢 **Идентичность двигателей по номеру** (route /zavod) — номер не уникален во времени, авто-слияние опасно. Возможная нитка «repair-case с суррогатным ID». Дозревает в /zavod.
