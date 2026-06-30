# Паспорт: Мой круг + Производство

## Зона
- Группы: `history`, `production`
- Табы: `history`, `engines`, `engine_brands`, `parts`, `part_templates`, `engine_assembly_bom`

## Ключевые UX-цели
- Быстрый вход в рабочий контекст (последние переходы, закреплённые сущности/отчёты).
- Производственные списки и карточки должны быть плотными, но читаемыми.
- BOM/связи марки–детали — без визуального шума, с явными проблемными местами.

## Экранные паттерны
- Lists: фильтры + таблица + переход в карточку.
- Cards: `EntityCardShell` с full-width для крупных блоков.
- BOM: комбинированный табличный/структурный вид.

## Source map
- Главная история/quick start: `electron-app/src/renderer/src/ui/pages/HistoryPage.tsx`
- Двигатели list/detail: `EnginesPage.tsx`, `EngineDetailsPage.tsx`
- Марки list/detail: `EngineBrandsPage.tsx`, `EngineBrandDetailsPage.tsx`
- Детали list/detail: `PartsPage.tsx`, `PartDetailsPage.tsx`
- Шаблоны деталей: `PartTemplatesPage.tsx`, `PartTemplateDetailsPage.tsx`
- BOM list/detail: `EngineAssemblyBomPage.tsx`, `EngineAssemblyBomDetailsPage.tsx`

## Важные ограничения
- При правках списков не ломать переход list -> card и обратно.
- Для производственных чисел/количеств сохранять выравнивание и компактный ритм.
