---
session: main
status: active
updated: 2026-10-02
---

# Session Handoff

**Статус: ACTIVE** — нитка «зеркала справочников в синк» (план
`docs/plans/sync-mirror-dictionaries-2026-10.md`, ветка `feat/sync-mirror-dictionaries`).

Строгие `erp_counterparties` / `erp_contracts` / `directory_engine_brands` — в sync-контракт
pull-only по образцу `warehouse_locations` (R3). EAV остаётся источником правды, запись не трогаем.

Код готов (S1–S5): миграция 0102, контракт 28 таблиц, публикатор словарей, apply/publish
на сервере, реплики 0027–0029 + parity в трёх цепочках, apply в `syncService`, читатели
лукапов на строгих репликах. Все гейты зелёные (shared 1278, backend 956, electron 1362,
android 79, lint, typecheck×2), живые пробы на пустой PG — S1 (pending-гард 6/6) и S3
(publish→pull с seq). Прототипные таблицы 0006 чуть не уронили цепочку android —
поймано их же тестами, лечено сносом прототипа по маркеру `code`.

## Следующий шаг

Открыть PR → ревью → мерж. S6 (релиз отдельным релизом + приёмка на проде) — после мержа.
