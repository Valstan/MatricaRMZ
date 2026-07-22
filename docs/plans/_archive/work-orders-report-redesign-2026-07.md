# План: редизайн печатной формы «Отчёт по нарядам»

> Задание владельца (2026-07-08): переделать печать «Отчёт по нарядам» — красиво как форма печати нарядов; перепроверить все доступные поля; гибкая фильтрация по каждому полю по отдельности; добавление/исключение колонок; печать и сортировка по статусам. (Баг ложного «просрочено» — отдельный фикс #117, уже на main.)

## Статус: ▶️ В РАБОТЕ (backend-only, electron main + shared; UI-контролы существующие)

## Контекст (проверено по коду + разведка агента)
- Отчёт считается ЦЕЛИКОМ в electron-main (`reportPresetService.ts`), НЕ в backend. Пресет — `shared/src/domain/reports.ts:451`.
- `buildWorkOrdersReport` (`reportPresetService.ts:1656`): фикс. набор полей строки, hardcoded sort `orderDate desc`, колонки = статичный `preset.columns`.
- Печать: генерик `renderReportHtml` (плоская таблица, `#f1f5f9` шапка) — это и надо украсить под эталон формы наряда (`WorkOrderDetailsPage.buildPrintModel` + `printPreview.ts`: тёмные рамки `#0f172a`, `#f3f4f6` шапка, центр. заголовок, `@page A4`).
- **Ключ:** «добавить/исключить колонки», новые фильтры и сортировка выражаются через СУЩЕСТВУЮЩИЕ типы фильтров (`multi_select`+inline options+`selectAllByDefault`, `date_range`, `text`, `select`) — их контролы в `ReportPresetPage` уже рендерятся. Новый UI-компонент НЕ нужен.

## Решения (технические, за мной — memory `delegate-technical-decisions`)
1. **Чистая логика — в новый shared-модуль** `shared/src/domain/workOrdersReport.ts` (без electron-deps): суперсет колонок, сортировка (вкл. по статусу), проекция выбранных колонок, красивый HTML-рендер. → тестируемо + можно отрендерить образец.
2. **Суперсет колонок** (все доступные поля): Дата выдачи, № наряда, Тип, Статус, Начало работ, Срок, Дата выполнения, Виды работ, Марка дв., № дв., Исполнители, Кол-во бригады, Ответственный, Сумма.
3. **Add/remove колонок** = `multi_select` фильтр `columns` (inline options = все колонки, `selectAllByDefault`). Пусто → все (нельзя отчёт без колонок). Билдер всегда считает суперсет полей, результат-колонки проецируются по выбору.
4. **Фильтры по полям:** issued range, due range, **completed range** (нов.), **statusCodes** multi (заменяет single `statusCode`+`overdueOnly`), **kinds** multi (нов., тип наряда), responsibleIds, brandIds, **numberQuery/engineNumberQuery/workTypeQuery** text (нов.). Пустой multi = все.
5. **Сортировка:** `sortBy` select (orderDate/status/number/dueDate/completedDate/engineBrand/amount) + `sortDir` select. По статусу — порядок срочности: overdue→issued→done_late→done.
6. **Печать статусов:** цветная ячейка статуса (палитра как в списке нарядов), статус — колонка по умолчанию.
7. **Красивый HTML:** тёмные рамки `#0f172a`, `#f3f4f6` шапка, центр. заголовок, чипы-сводка фильтров в подзаголовке, `@page A4`, блок «Итого». Рендер вызывается из `renderReportHtml` спец-кейсом.

## Изменения
- `shared/src/domain/workOrdersReport.ts` (нов.) + тест.
- `shared/src/domain/reports.ts` — пресет `work_orders_report`: новые фильтры + колонки из суперсета.
- `reportPresetService.ts` — `buildWorkOrdersReport`: суперсет полей строки (вкл. statusCode/kindLabel/startDate/completedDate/performers/crewCount), новые фильтры, сортировка, динамич. колонки; `renderReportHtml` спец-кейс → shared-рендер.

## Гейты
build shared + shared test (sort/columns/HTML) + electron typecheck/lint/test. Образец HTML отрендерить и отправить владельцу на «красиво»-оценку (live electron-verify тяжёл; HTML — чистая функция, образец нагляднее).

## Релиз
Client-only (отчёт в electron). Доходит с релизом. Прод-деплой не нужен для этого PR.
