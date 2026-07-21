# Отчёт «Двигатели и контракты» (engines_contracts_overview)

**Статус:** реализовано в ветке `feat/engines-contracts-overview-report` (2026-07-21). Ожидает CDP-smoke + merge.

## Context

Владельцу нужен управленческий отчёт по двигателям/маркам/контрактам, отвечающий на вопросы завода: **план по контракту → приехало → отгружено обратно → осталось на заводе несделанных**. Разведка показала: механика уже есть, но разрозненно (отчёты `engines_list`, `engine_stages`, метрики контракта в `ContractsPage`). Решение — один новый пресет-отчёт с переключателем разреза и сворачиваемыми секциями фильтров (образец — Прогноз сборки), сохраняемые шаблоны/экспорт/печать бесплатно из движка пресетов.

## Что сделано

- **`shared/src/domain/reports.ts`** — id `engines_contracts_overview` в union; определение пресета (title «Двигатели и контракты», фильтры, дефолтные колонки); супер-сеты колонок `ENGINES_CONTRACTS_CONTRACT_COLUMNS` / `_BRAND_COLUMNS` / `_ENGINE_COLUMNS` + `selectEnginesContractsEngineColumns`.
- **`electron-app/src/main/services/reports/presets/engines.ts`** — `buildEnginesContractsOverviewReport`: ветвление по `groupBy` (contracts/brands/engines). Переиспользует `resolveEngineShippingState`, `isScrapEngine`, `collectContractEngineQty`, `effectiveContractDueAt`, `parseContractSections`. KPI (backlog, TAT, доля утиля, on-time) — в `footerNotes`.
- **`dispatch.ts`** — import + case.
- **`reportUtils.ts`** — метки итогов (`planQty`, `arrivedQty`, `atFactoryQty`, `shippedQty`, `avgTatDays`, …).
- **`ReportPresetPage.tsx`** — `renderEnginesContractsFilters()`: 4 сворачиваемые секции (Разрез / Период / Отбор / Состояние) с живыми сводками, каждый контрол через общий `renderFilterControl`. Подключено в панель фильтров для нового пресета.
- **`EnginesPage.tsx` + `App.tsx`** — кнопка-вход «Двигатели и контракты» (`openReportPreset('engines_contracts_overview')`).

## Ключевые определения (семантика)

- **План** = сумма марок в `contract_sections` (`collectContractEngineQty`, fallback `engine_count_total`).
- **Приехало** = число заведённых двигателей контракта.
- **Отгружено (покинул завод)** = `status_customer_sent`/`_accepted` (через `resolveEngineShippingState`) ИЛИ утиль-возврат `status_rework_sent`.
- **На заводе** = не покинул завод. **Ожидается** = max(0, план − приехало).
- **Период** по умолчанию `none` (за всё время); опц. по дате прихода/отгрузки.

## Verify

- ✅ build shared, typecheck (shared + electron-app), lint — зелёные.
- ⏳ CDP e2e-smoke: Отчёты → «Двигатели и контракты» → разрезы contracts/brands/engines, сохранение шаблона, печать.
- Новых EAV-атрибутов и DDL нет.
