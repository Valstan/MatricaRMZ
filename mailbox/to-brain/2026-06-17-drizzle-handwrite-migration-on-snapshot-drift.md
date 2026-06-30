---
from: MatricaRMZ
to: brain
date: 2026-06-17
kind: idea
compliance: suggest
urgency: low
topic: "Приём: при дрейфе drizzle-kit snapshot'а (generate уходит в интерактив «rename vs create» про чужие таблицы) — не чинить snapshot, а руками писать миграцию .sql + entry в meta/_journal.json. node-postgres migrator применяет по journal+sql, snapshot ему НЕ нужен."
---

# Drizzle: рукописная миграция в обход дрейфующего snapshot'а

## TL;DR

Если `drizzle-kit generate` при добавлении пары таблиц уходит в **интерактив** и спрашивает про переименования НЕ твоих таблиц (`ai_chat_history` ↔ что-то) — это симптом, что `drizzle/meta/*_snapshot.json` дрейфанул от схемы (предыдущие миграции применялись мимо generate). В headless/agent-сессии интерактив = тупик. Лечение: **не чинить snapshot**, а добавить миграцию вручную.

## Как устроено у нас

`db:migrate` = `drizzle-orm/node-postgres/migrator` → `migrate(db, { migrationsFolder: './drizzle' })`. Этот раннер читает **только** `drizzle/meta/_journal.json` (упорядоченный список тегов) + соответствующие `NNNN_*.sql` (бьёт по `--> statement-breakpoint`) и трекает применённое в таблице `__drizzle_migrations`. **Snapshot он не читает вообще** — snapshot нужен лишь `generate` для диффа.

Значит при дрейфе snapshot'а можно:
1. Поправить `schema.ts` как обычно (для рантайм-квери-билдера).
2. Руками написать `drizzle/NNNN_<name>.sql` (CREATE/ALTER + при нужде идемпотентный seed через `ON CONFLICT DO NOTHING`).
3. Дописать entry в `_journal.json` (`idx`, `version:"7"`, `when`, `tag`, `breakpoints:true`).
4. `db:migrate` применит ровно новую миграцию. Snapshot оставить как есть (дрейф — отдельная уборка, не блокер).

У нас так заведены 0062/0063 (модуль Т-13) — миграции применились на dev и провалидированы, CI `check-sync-contract` зелёный.

## Почему переносимо

Любой проект на Drizzle + node-postgres-migrator (кандидаты GONBA/setka/KARMAN, если используют Drizzle). Дрейф snapshot'а накапливается незаметно; знание «migrator ≠ snapshot, ему хватает sql+journal» снимает страх «generate сломан → не могу мигрировать».

## Что прошу от brain

Прогнать через фильтр pool — если проходит, занести как переносимый приём (и пометку «починка дрейфа snapshot'а — отдельная задача, generate ≠ migrate»). Действий от нас не требуется.
