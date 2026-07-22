# Паспорта шаблонов разметки

Этот файл фиксирует типовые шаблоны UI, которые повторяются по всей программе.

## T1: List Page (список сущностей)
- Назначение: быстрый обзор и переход в карточку.
- Каркас: toolbar фильтров + таблица/плитки + пагинация/статус.
- Типовые source:
  - `electron-app/src/renderer/src/ui/pages/*Page.tsx` (list-экраны)
  - `electron-app/src/renderer/src/ui/components/WarehouseListPager.tsx`
  - `electron-app/src/renderer/src/ui/components/TwoColumnList.tsx`

## T2: Entity Card (карточка сущности)
- Назначение: редактирование и просмотр деталей объекта.
- Каркас: `EntityCardShell` + `SectionCard` блоки, full-span для тяжелых таблиц.
- Типовые source:
  - `electron-app/src/renderer/src/ui/components/EntityCardShell.tsx`
  - `electron-app/src/renderer/src/ui/components/SectionCard.tsx`

## T3: Document/Form Card (операционный документ)
- Назначение: заявка/наряд/складской документ с табличными строками.
- Каркас: header actions + статус + строки документа + summary/footer.
- Типовые source:
  - `SupplyRequestDetailsPage.tsx`
  - `WorkOrderDetailsPage.tsx`
  - `StockDocumentDetailsPage.tsx`

## T4: Report Builder (шаблон отчёта)
- Назначение: фильтры/настройки + результат + экспорт.
- Каркас: split layout + preview area + PDF/CSV/XML actions.
- Типовые source:
  - `ReportPresetPage.tsx`
  - `AssemblyForecastReportView.tsx`

## T5: Catalog/Reference Table
- Назначение: справочники с поиском/сортировкой.
- Каркас: компактный toolbar + table + массовые действия.
- Типовые source:
  - `NomenclaturePage.tsx`
  - `MasterdataDirectoryPage.tsx`
  - `AdminUsersPage.tsx`

## Универсальный шаблон запроса на UI-изменение
```md
Экран/модуль:
Шаблон (T1..T5):
Цель изменения:
Что оставить без изменений:

Визуал:
- ширина/центрирование:
- плотность:
- акценты:

Поведение:
- default state:
- expanded/collapsed:
- пустые состояния:

Данные:
- показывать:
- скрыть:
- формат строки/ячейки:

Ограничения:
- desktop min width:
- нельзя ломать:
```
