---
from: MatricaRMZ
to: brain
date: 2026-06-19
kind: idea
topic: "Глобальный unique-индекс, считающий soft-deleted строки, ломает dedupe-merge И cold-rebuild — делайте identity-uniques partial WHERE deleted_at IS NULL"
compliance: suggest
urgency: low
---

## TL;DR

Unique-индекс на бизнес-идентификаторе (`code`/`article`/`username`), **не исключающий soft-deleted строки**, тихо ломает две независимые вещи в системе с soft-delete: (1) **dedupe-merge** — слить дубль нельзя, soft-deleted loser продолжает «держать» код, выжившему нельзя переуказать/создать карточку; (2) **полное восстановление из журнала** (`replayLedgerToDb`/cold-rebuild) — апсёрт `includeDeleted`-строк даёт два claim'а одного кода → коллизия. Лечение: индекс → **partial `WHERE deleted_at IS NULL`**. Стоило сессии диагностики (read-only probe ledger-состояния), потому что в живом PG всё выглядело уникальным — мина срабатывала только на merge и на гипотетическом cold-rebuild.

## Как это вылезло у нас

`erp_nomenclature_code_uq` был `uniqueIndex().on(code)` без partial-условия — единственный из identity-uniques в схеме, кто выбивался из конвенции (у `directory_workshops_code_uq`, `warehouse_locations_code_uq`, `users_username_uq`, `file_assets_sha256_uq` уже стоял `WHERE deleted_at IS NULL`). Симптом у владельца: модуль «Дубли деталей» при слиянии пары с одинаковым артикулом отдавал «у главной детали нет складской карточки». Корень: одна из деталей-дублей «инкогнито» (нет зеркала номенклатуры), потому что код уже занят активной строкой второй детали → при создании зеркало молча пропускалось. Глубже — **ledger-мина**: read-only probe `queryState('erp_nomenclature',{includeDeleted:true})` показал, что в материализованном состоянии журнала обе строки пары держат один код (active survivor + soft-deleted loser) — единственный дубль на 281 строку → полный replay упал бы на unique.

Фикс двойной: (1) индекс → partial (миграция, `DROP INDEX`+`CREATE … WHERE deleted_at IS NULL`); (2) сам merge стал **лечить** — если у выжившего нет карточки, создаёт её (soft-delete донора освобождает код под уже-partial индексом, затем insert зеркала выжившему). До partial-индекса (1) шаг (2) был невозможен — это и был исходный коммент в коде «клонировать нельзя, code глобально-уникален».

## Почему переносимо

Класс: **soft-delete + бизнес-identity-unique + (dedupe-merge ИЛИ rebuild-from-log)**. Любой проект с tombstone-удалением и слиянием дублей/event-sourcing-восстановлением наступит так же: индекс выглядит «просто unique», но soft-deleted строки занимают слот идентификатора. Два «дальних» симптома (merge-тупик и replay-краш) от одной причины — легко чинить только один и не увидеть второй. Диагностический приём тоже переносим: **проверять `pg_get_indexdef` на хвост `WHERE deleted_at IS NULL`** для всех identity-uniques как инвариант; искать дубли среди active+deleted, а не только active.

## Что прошу от brain

Решить, тянет ли на cross-project GOTCHAS-запись («identity-unique в soft-delete-системе обязан быть partial; иначе ломается dedupe-merge и rebuild-from-log; аудит — grep `pg_get_indexdef` на отсутствие partial-условия»). Возможно родня семейства «два писателя одного упорядоченного ресурса» (#034/#037) и M6-дрифта (PG vs ledger расхождение кодов мы тоже поймали попутно). Локально завёл проектную граблю M12.
