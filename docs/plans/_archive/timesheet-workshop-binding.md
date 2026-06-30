# План: привязка сотрудник→цех + «Добавить весь цех» в табеле (A1 из T-13 pass-2)

> **Статус (2026-06-20):** код реализован, в `main` после мержа PR. Гейты зелёные (build/typecheck/lint/297 backend-тестов) + CDP-smoke (поле «Цех» рендерится на карточке сотрудника рядом с «Подразделение»). **НЕ зарелижено** — ждёт `/reliz`. Бэкофилл — массовое назначение цеха на странице сотрудников (выбор владельца).

> Источник: владелец 2026-06-20 выбрал «Привязка к цеху (A1)». Контекст — директива brain `2026-06-18-timesheet-t13-pass2`. Pass-2 уже зарелижен (v2026.618.1128); там «добавить весь цех» сделано как группировка по **подразделению** (employee→цех связи в схеме не было). Эта нитка добавляет настоящую связь employee→цех.

## Модель данных (выяснено)

- **Табель scope = цех XOR подразделение** (migration 0067, `timesheets.workshopId` → `directory_workshops` **или** `timesheets.departmentId` → `department` entity; CHECK xor). `timesheetService` отдаёт `scopeKind: 'workshop'|'department'`.
- **Сотрудник → подразделение:** EAV `department_id` (→ entity типа `department`). **Сотрудник → цех: связи НЕТ.**
- **Цеха** — таблица `directory_workshops` (server-side, HTTP `/workshops`, НЕ EAV-entity, НЕ в клиентском SQLite). Клиент берёт список через `window.matrica.workshops.list()`.
- Карточка сотрудника (`EmployeeDetailsPage.tsx`): `department_id` — `dataType:'link'` (`linkTargetTypeCode:'department'`), рендер `SearchSelectWithCreate` из `employees.departmentsList()`; def регистрируется в `desired`+`ensureAttributeDefs` (стр. ~345).
- Пикер табеля (`TimesheetGridPage.tsx`): уже фильтрует уволенных (`resolveEmploymentStatusCode === 'working'`), группирует по `departmentName`; уже грузит `workshops.list()` (стр. 81).

## Решение

Новый EAV-атрибут **`workshop_id`** у сотрудника (хранит UUID `directory_workshops`). Зеркало `department_id`, но опции — из `workshops.list()` (цеха не EAV-entity, поэтому это `text`-атрибут с кастомным select-рендером, не `link`). Синкается обычным EAV-путём — спец-обработки sync не нужно.

«Добавить весь цех» в пикере = добавить всех **работающих** сотрудников, у кого `workshop_id === timesheet.workshopId` (для цех-scoped табеля). Для dept-scoped табеля поведение pass-2 (по подразделению) сохраняется.

## Изменения

1. **`shared/src/ipc/types.ts`** — `EmployeeListItem += workshopId?: string | null`.
2. **`electron-app/src/main/services/employeeService.ts`** (`listEmployeesSummary`) — добавить `workshop_id` в `defIds`, вернуть `workshopId` в item (raw id; имя цеха резолвит UI по `workshops.list()`).
3. **`EmployeeDetailsPage.tsx`** — (а) зарегистрировать def `workshop_id` (`name:'Цех'`, `dataType:'text'`, sortOrder 105) в `desired`; (б) грузить `workshops.list()`; (в) поле «Цех» (`SearchSelectWithCreate` из цехов, save через `employees.setAttr(id,'workshop_id',value)`); display id→name по списку цехов. Create-new цеха — опционально (можно через `workshops.upsert`); MVP — только выбор.
4. **`TimesheetGridPage.tsx`** — (а) кнопка **«Добавить весь цех»** (видна, когда табель цех-scoped, `t.timesheet.workshopId` задан): добавляет работающих с `workshopId === timesheet.workshopId`; (б) опц. фильтр по цеху в пикере рядом с фильтром по подразделению (по `workshopId`→имя из `workshops.list()`).
5. **Бэкофилл** — у сотрудников цех не проставлен; источника для авто-заполнения НЕТ → оператор назначает цех. См. «Решение по бэкофиллу» ниже.

## Решение по бэкофиллу (вопрос владельцу)
Назначить цех ~всем сотрудникам — ручная работа. Варианты: только карточка (по одному) vs карточка + bulk-инструмент (выбрать многих → проставить цех разом). Уточняется у владельца.

## Verify
- Гейты: build shared+ledger → typecheck → lint → backend test → CDP-smoke (`verify`): назначить цех сотруднику на карточке → в цех-scoped табеле «Добавить весь цех» тянет только этого/работающих этого цеха; уволенный не попадает.

## Релиз
Отдельным `/reliz` (слот за владельцем). Уедет вместе с накопленным батчем.
