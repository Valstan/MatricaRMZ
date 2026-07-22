# Паспорт: Снабжение

## Зона
- Группа: `supply`
- Табы: `requests`, `work_orders`, `tools`, `products`, `services`

## Ключевые UX-цели
- Операционный контур «сформировал -> согласовал -> исполнил» без лишних кликов.
- В списках снабжения важны статус, актуальность и быстрые действия.
- Для инструментов/товаров/услуг — консистентный каталог с предсказуемым поиском.

## Экранные паттерны
- `SupplyRequestsPage` (T1), `SupplyRequestDetailsPage` (T3)
- `WorkOrdersPage` (T1), `WorkOrderDetailsPage` (T3)
- `NomenclatureDirectoryPage` для `tools/products/services` (T5)

## Source map
- Заявки list/detail: `SupplyRequestsPage.tsx`, `SupplyRequestDetailsPage.tsx`
- Наряды list/detail: `WorkOrdersPage.tsx`, `WorkOrderDetailsPage.tsx`
- Инструменты: `ToolsPage.tsx`, `ToolDetailsPage.tsx`, `ToolPropertiesPage.tsx`
- Товары: `ProductsPage.tsx`, `ProductDetailsPage.tsx`
- Услуги: `ServicesPage.tsx`, `ServiceDetailsPage.tsx`
- Общий каталог снабжения: `NomenclatureDirectoryPage.tsx`, `nomenclatureDirectoryPresets.ts`

## Важные ограничения
- Не ломать жизненный цикл статусов заявки и подписания.
- Изменения в отображении каталога не должны ломать критерии legacy/fallback отбора.
