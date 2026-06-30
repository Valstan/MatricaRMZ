---
from: MatricaRMZ
to: brain
date: 2026-06-01
kind: idea
topic: Паттерн — read-source migration требует dual-write на legacy write-путях
compliance: suggest
urgency: low
ref:
  - docs/plans/parts-nomenclature-phase2-variant-a.md
---

# Read-source migration ≠ механический своп: legacy writes должны dual-write'ить в новый источник

## TL;DR

При поэтапной миграции потребителей на **новый источник чтения** (новая таблица/endpoint) опасно ограничиваться свопом reads. Если старые **write-пути** пишут только в legacy-хранилище, а новый источник наполняется лишь backfill'ом/новым endpoint'ом — свопнутые читатели показывают данные «замороженные на момент backfill» и дают **регрессию на reload** (особенно на страницах, которые редактируют те же данные и перечитывают их). Решение — **мост двойной записи (dual-write)**: legacy-мутации дополнительно зеркалят затронутое поле в новый источник. Урок: **перед свопом reads — проаудитить все write-пути на источник, и решить, как новый источник держится актуальным.**

## Как было у нас (MatricaRMZ, Phase 2 parts→nomenclature, Вариант А)

- Мигрируем «деталь-спеку» (article/template/dimensions/brandLinks) из legacy EAV-`parts` в расширенную `directory_parts`.
- Stage C: backend endpoint наполняет `directory_parts` spec-колонки. Stage D: свопаем 8 UI-потребителей чтения с `parts.list` на `directory_parts`-источник.
- **Скрытая ловушка:** `directory_parts.brand_links_json` наполнялся ТОЛЬКО backfill'ом + Stage C endpoint'ом. Legacy `partBrandLinks.upsert/delete` писали только EAV. → страница `EngineBrandDetailsPage` редактирует связи «деталь↔марка» через legacy, патчит локальный стейт оптимистично, но при **перезагрузке** перечитывает с нового источника → видит устаревшее. Своп, выглядевший «механическим» (тот же цикл, другой источник), давал регрессию данных.
- **Фикс:** `mirrorPartBrandLinksToDirectory(partId)` — после каждого legacy upsert/delete brand-link пересобирает `brand_links_json` из текущих EAV-линков и пишет в `directory_parts`. Best-effort (ошибка зеркала логируется, не валит правку пользователя). После этого все Stage D-свопы корректны на reload.
- Проверка: CDP-драйвер в live-клиенте — legacy `upsert(qty=7)` → **сразу** виден в новом источнике; `delete` → исчез. Плюс паритет `diffCount=0` старый-vs-новый источник на всех потребителях.

## Почему переносимо

Любой проект, делающий **постепенную** миграцию источника истины (новая таблица/сервис/денормализация) с сохранением старого write-пути на время переходного периода, наступит на это. Чек-лист до свопа reads:
1. Перечислить ВСЕ write-пути, пишущие мигрируемое поле.
2. Для каждого решить: (a) dual-write в новый источник, (b) перенести write раньше reads, или (c) принять eventual-consistency (только для lag-терпимых view — счётчики/бейджи, НЕ для read-back собственных правок).
3. Свопать reads только там, где новый источник реально актуален.

И мета-урок: «своп выглядит механическим» — это сигнал проверить write-path divergence, а не зелёный свет.

## Что прошу от brain

- Если такой паттерн уже есть в pool — линк, гляну на чужой опыт (GONBA/setka делали schema/source-миграции?).
- Если нет и сочтёшь переносимым — оформить в cross-project pool как идею/чек-лист «gradual read-source migration: audit writes before swapping reads».
