---
from: MatricaRMZ
to: brain
date: 2026-06-10
kind: report
urgency: normal
ref:
  - 2026-06-09-universal-tiered-search
  - 035
topic: "Ответ по #035: инвентарь полей поиска (4 кластера) + находка — ~70% модуля уже построено (`searchMatching.ts`: нормализация, compact-номера, многотокен AND, substring+subsequence ранг, подсветка), но подключено только к 3 select-компонентам; 22 списочные страницы и web-admin живут на ad-hoc фильтрах. Не хватает: fuzzy (Ур.3) и RU↔EN раскладки. Фазовый план: lift в shared + достроить → пилот на 3 горячих полях → rollout 22 страниц → серверные typeahead (pg_trgm). 3 открытых вопроса владельцу."
---

# Ответ #035: инвентарь + фазовый план

## Главная находка probe (не переоткрываем!)

В репо **уже есть ~70% спека #035**: `electron-app/src/renderer/src/ui/utils/searchMatching.ts` — нормализация (lower, ё→е, пунктуация→пробел), **compact-сравнение номеров** (`240-1`≡`2401` — уже покрыто), многотокен AND, ранжирование exact→prefix→substring→**subsequence** (Ур.1+Ур.2 есть), подсветка (`buildLookupHighlightParts`). Есть юнит-тесты (`searchMatching.test.ts`).
**Чего нет:** Ур.3 fuzzy (опечатки/перестановки), автокоррекция раскладки RU↔EN. **Где лежит:** renderer-utils электрона — недоступен web-admin'у и backend'у.

## Инвентарь потребителей (#022, 4 кластера)

1. **Select/typeahead-компоненты электрона — УЖЕ на едином матчере:** `SearchSelect`, `GroupedSearchSelect`, `MultiSearchSelect` (+обёртка `SearchSelectWithCreate`) — ~33 файла-потребителя по всем карточкам/формам. Боль владельца «знай начало наименования» здесь уже решена (substring+subsequence), но без fuzzy/раскладки.
2. **Фильтры списочных страниц электрона — ad-hoc, 22 страницы** (поле «Поиск…»): Engines, Nomenclature, WorkOrders, StockBalances, StockDocuments, StockInventory, SupplyRequests, Employees, EmployeeDetails, Counterparties, Contracts, ContractDetails, EngineBrands, AdminUsers, Admin, Changes, WarehouseLocations(+Admin), Reports, ReportPreset, ToolProperties, WorkOrderTemplates. Внутри — свои `filter(...includes...)` поверх `ui/utils/search.ts` (collect-all-fields substring) либо локальные lowercase-фильтры: substring в основном есть (не prefix-only), но **нет** subsequence/fuzzy/раскладки/ранга/подсветки, и логика размазана.
3. **web-admin — отдельный дубль:** свой `web-admin/src/ui/components/SearchSelect.tsx` + страничные фильтры (Admin, AdminUsers, ClientAdmin, Contracts, Diagnostics, Engines) — копия логики, уже дрейфует от электроновской.
4. **Серверные list/typeahead (Postgres):** ILIKE-поиск в `reports.ts`, `warehouseService.ts` (+ q-параметры list-эндпоинтов — полная перепись по месту в фазе Ф3). Клиентские списки в основном тянутся из локального SQLite целиком и фильтруются в JS — поэтому центр тяжести #035 у нас в JS-матчере, не в SQL.

## Фазовый план

- **Ф0 — shared-модуль (фундамент, чистый, без UI):** lift `searchMatching.ts` → `shared/src/domain/tieredSearch.ts`; добавить Ур.3 fuzzy (токенный Дамерау-Левенштейн, гейт длины ≥3, только как fallback при пустых Ур.1-2) и RU↔EN маппинг (запрос дублируется в обеих раскладках, идёт в тот же ранг); перенести тесты + новые. web-admin переключить на shared — дубль умирает.
- **Ф1 — пилот на горячих полях владельца:** EnginesPage («последние цифры номера» — ранг+подсветка+fallback), NomenclaturePage (крупнейшая таблица — **probe латентности Ур.3 на прод-объёме до включения**, #020), StockBalancesPage. CDP /verify на каждом.
- **Ф2 — rollout остальных ~19 страниц:** замена ad-hoc фильтров на shared-ранг (правка точечная на страницу), подсветка где дёшево.
- **Ф3 — серверные typeahead:** `pg_trgm` GIN на номенклатуре (ускоряет и `ILIKE '%q%'`, и fuzzy), debounce+min-chars сверка по всем серверным полям.

Ф0 компактна и независима — могу взять короткой фазой между большими нитками (слотинг-предложение в письме client-perf).

## Открытые вопросы владельцу

1. **Подсветка совпадений в больших таблицах-списках** (не только в выпадашках) — нужна везде или достаточно выпадающих списков? (стоимость рендера на сотнях строк)
2. **Ур.3 (похожие) при пустом точном результате** — показывать автоматически с пометкой «похожие» или по явной кнопке? (риск: оператор примет похожее за точное)
3. **Приоритет полей пилота** — двигатели → номенклатура → остатки склада: верный порядок?
