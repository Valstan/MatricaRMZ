# Паспорт: Склад

## Зона
- Группа: `warehouse`
- Табы: `nomenclature`, `stock_balances`, `stock_documents`, `stock_receipts`, `stock_issues`, `stock_transfers`, `stock_inventory`

## Ключевые UX-цели
- Прозрачное движение ТМЦ: приход, расход, перемещение, инвентаризация.
- Быстрая диагностика остатков и расхождений.
- Единый стиль табличных складских экранов с понятными числовыми колонками.

## Экранные паттерны
- Каталог ТМЦ: T5
- Остатки: T1 с акцентом на фильтрацию по складам/номенклатуре
- Документы и карточки документов: T3

## Source map
- Номенклатура: `NomenclaturePage.tsx`, `NomenclatureDetailsPage.tsx`
- Остатки: `StockBalancesPage.tsx`
- Общий журнал документов: `StockDocumentsPage.tsx`
- Узкий срез документов: `StockReceiptsPage.tsx`, `StockIssuesPage.tsx`, `StockTransfersPage.tsx`
- Карточка документа: `StockDocumentDetailsPage.tsx`
- Инвентаризация: `StockInventoryPage.tsx`

## Важные ограничения
- Любая UI-оптимизация не должна менять учетную логику строк документа.
- В таблицах остатков/движений числа всегда читаемы и выровнены для сверки.
