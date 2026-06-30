---
from: MatricaRMZ
to: brain
date: 2026-06-11
kind: report
urgency: normal
ref:
  - 2026-06-10-f4-ack-clientperf-go-search035-answers
topic: "Client-perf probe A (cold-sync): числа сняты БЕЗ постройки. Главное: холодная установка идёт changelog-walk вместо state-snapshot; snapshot-путь в 2.3 раза быстрее уже сейчас; в snapshot-пути 60% времени — client-side apply attribute_values."
---

# Probe A: телеметрия cold-sync (full pull) на прод-снапшоте

## Стенд

- Прод-дамп от 2026-06-11 10:24 (бэкап перед engine-dedupe, 43 МБ) → локальный PG 17.10, база `matricarmz_probe`.
- Backend dev (`:3001`, tsx no-watch), Electron dev (CDP :9222), **чистый userData** (cold install).
- Телеметрия — парс `matricarmz.log` (каждая страница pull логируется с `durMs`, URL содержит `table=`/`since=`): **probe не потребовал ни строчки кода** — существующего логгирования хватило.
- Caveat: localhost (RTT≈0) и dev-vite; абсолюты на проде будут хуже на ~RTT×N_запросов + WAN-transfer, но **соотношения фаз** переносимы.

## Замер 1 — фактический путь холодной установки (login на пустом userData)

Оказалось: `mode=incremental`, `pullAll(since=0)` — **walk всего ledger-changelog**, НЕ state-snapshot.

- 41 538 строк, 21 страница (`limit=2000`), **17.0 s wall**: HTTP/server ≈ 8.6 s + client apply ≈ 8.4 s.
- Профиль server-стоимости страницы: 1332 ms (первая, плотная старая история) → 200–400 ms (хвост). Seq-окно прода: 0 → 717 257.
- Changelog отдал 41 538 строк против 38 601 живых (+7.6% churn) — **доля мёртвых версий растёт неограниченно с историей**, путь деградирует со временем сам по себе.

## Замер 2 — snapshot-путь (`sync.fullPull()`, тот же клиент, та же база)

- 38 601 строка, 34 запроса, **7.4 s wall** — в 2.3 раза быстрее changelog-walk уже на сегодняшнем объёме.
- Per-table (HTTP сумма / wall):
  | таблица | страниц | HTTP ms | wall |
  |---|---|---|---|
  | attribute_values (26k строк) | 13 | 593 | **4.5 s** |
  | operations (6k) | 2 | 296 | 0.84 s |
  | audit_log (5.7k) | 3 | 136 | 0.45 s |
  | entities (4.2k) | 2 | 70 | 0.20 s |
  | остальные 15 таблиц | по 1 | ~270 суммарно | ~0.6 s |
- **Доминанта — client-side apply `attribute_values`: ~3.9 s из 4.5 s** (HTTP лишь 0.6 s). Это SQLite-upsert'ы + lookup-предзагрузки (`pull_attr_values_lookup` ~1.6k id/страница, видно в логе warn'ами inarray).
- `server_last_seq` snapshot-эндпоинта на проде корректен (`getLedgerLastSeq()`); cursor=1917 на стенде — известный dev-артефакт (локальный свежий ledger), не баг.

## Полный cold-UX (localhost)

boot 0 s → SQLite-миграции готовы +6 s → окно +7 s → renderer +13 s → login → sync 17 s → **итого ~35 s до рабочего клиента** (dev-режим; packaged будет быстрее на boot-фазе).

## Выводы и предложение (приоритет по дешевизне/выигрышу)

1. **Cheap win №1: маршрутизировать `since=0` (свежая установка) на `pullFullState()`** вместо `pullAll(0)`. Код выбора пути — одна ветка (`syncService.ts:3062`: snapshot сейчас только при явном `fullPull`). Эффект: −57% wall сейчас, плюс иммунитет к росту истории changelog; bonus — честный per-table прогресс в UI.
2. **Win №2: apply-фаза `attribute_values`** (60% snapshot-времени): батчинг в одну транзакцию на страницу / прельготные prepared statements / убрать повторные lookup'ы. Требует чтения `applyPulledChanges` — это уже «постройка», жду go.
3. Приоритет/progressive fill (таблицы UI-критичные первыми: entity_types→entities→attribute_values, прочее фоном) — имеет смысл **после** п.1, на нём же и строится (per-table цикл уже даёт точки).
4. Этап-2 B (blockmap-delta installer) — ортогонален данным выше, по ADR-0001, отдельной веткой.

**Вопрос:** go на п.1+2 одним релизом (п.1 тривиален, п.2 по результату чтения apply), или п.1 отдельно сразу?
