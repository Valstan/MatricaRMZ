# Двигатели: EAV → строгие таблицы (B4 трека B)

**Статус:** ACTIVE (2026-10-03, ветка `feat/contract-cutover-c4`, фаза 1)
**Контекст:** план [matrica-v4-kickoff-2026-08.md](matrica-v4-kickoff-2026-08.md), этап B4. Разведка писателей — 7 семейств (см. ниже).

## Семейства писателей (разведка 2026-10-03)

1. **Карточка двигателя (renderer)**: `saveAllAndClose` (~40 кодов: номера, клеймо, бренд, даты, заказчик/договор/секция/цех, рекламации 8, scrap, флаги, ENGINE_FLAT_FIELDS) + `saveAttr` (вложения) + `copyToNew` — всё sync-EAV.
2. **engineService.setEngineAttribute (main)**: единственный `engine:setAttr`, гейты дублей (заводской номер с обходом флагами; клеймо без обхода), дедуп строк, deferred-материализация.
3. **Резерв `engine_reservation`**: уже server-managed (REST + прямой PG + ledger), sync-push зарезан backstop'ом — не трогаем.
4. **adminMasterdataService.setEntityAttribute + engineNumberGuard (server)**: те же гейты + аудит статусов.
5. **enginePhaseService**: `engine_phase` уже strict-писатель (сервер) — не трогаем.
6. **applyPushBatch**: generic EAV-транспорт.
7. **Скрипты**: импорты, canonicalize, dedupe/merge (`merged_into`), backfill этапов (читают EAV, пишут operations — не трогаем).

## Решение

Одна широкая таблица `erp_engine_cards` (id = entities.id, колонка на поле карточки — номера, клеймо+год, бренд, даты, ссылки, рекламации, флаги, FLAT-поля), по образцу договоров: триггерное зеркало EAV→strict на переходный период, затем двери + freeze. Отдельных таблиц под рекламации/фазы не заводим (фазы уже в operations).

Поля-ссылки (contract_id, customer_id, engine_brand_id, workshop_id): uuid без жёстких FK (как слоты платежей — legacy-данные с битыми ссылками не должны ронять зеркало).

## Шаги

- **E1 (зеркало):** миграция (таблица + sync-колонки + `rebuild_erp_engine_card()` + триггеры + бэкфилл) + `engines:parity` (EAV↔strict). Без смены поведения: писатели и читатели не тронуты.
- **E2 (двери):** серверные двери записи карточки (полевой патч + dual-write EAV-след, как контракты) + гейты дублей на strict.
- **E3 (клиент):** `EngineDetailsPage` → двери (load через реплику + EAV-фолбэк, save одним патчем), `engineService.setEngineAttribute` → strict-реплика + push? или REST (решить: карточка правится в цеху с планшета — офлайн нужен! значит push через синк, как платежи, а не REST).
- **E4 (хвосты):** скрипты-писатели, `copyToNew`, dedupe/merge, `engines:parity` на проде.
- **E5 (freeze, после обновления парка):** гейт кодов engine в setAttr + push-backstop, снос триггеров.

## Вне скоупа

- `engine_reservation`, `engine_phase`, этапы/листы (уже strict) — не трогаем.
- `erp_engine_instances` (складской регистр) — связь карточка↔инстанс решается на E4.
- Уникальность заводского `engine_number`: действующий гейт с флагами обхода — переносится как есть.
