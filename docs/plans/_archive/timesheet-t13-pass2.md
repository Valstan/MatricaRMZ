# План: Табель Т-13 — доработки pass 2 + приветственное окно

> Источник: директива brain `2026-06-18-timesheet-t13-pass2-and-welcome-window.md` (kind=directive, compliance=recommend, urgency=normal). Модуль Т-13 (Ф1+Ф2) уже в `main`/проде. Это доработки по живой обкатке владельца + один баг.

## Контекст / где живёт код

- Грид: [`electron-app/src/renderer/src/ui/pages/TimesheetGridPage.tsx`](../../electron-app/src/renderer/src/ui/pages/TimesheetGridPage.tsx) — ячейки, кисть, баг комментария, печать.
- Список/создание: [`TimesheetsPage.tsx`](../../electron-app/src/renderer/src/ui/pages/TimesheetsPage.tsx).
- Печать-обёртка: [`utils/printPreview.ts`](../../electron-app/src/renderer/src/ui/utils/printPreview.ts) (секции с чекбоксами, CSS `@media print`).
- Домен: [`shared/src/domain/timesheet.ts`](../../shared/src/domain/timesheet.ts) (типы, легенда, подсчёты).
- Backend: `backend-api/src/services/timesheetService.ts` (`addTimesheetRows` уже принимает массив сотрудников — bulk-add без правок API), `routes/timesheets.ts`, IPC `electron-app/src/main/ipc/register/timesheets.ts`.
- Приветственное окно: уже построено в `App.tsx` (`renderReleaseWelcomeModal`, анимированная карточка) + данные в `shared/src/domain/releaseWelcome.ts` (`RELEASE_WELCOME_HISTORY`).

## Ключевое решение (A1 — данные)

Employees связаны с сущностью **Подразделение** (`department_id` EAV, `EntityTypeCode.Department`), а табель создаётся под `directory_workshops` (**цех**). **Прямой связи employee→workshop в схеме НЕТ.** Поэтому «добавить весь цех» реализуем как группировку по **Подразделению** (то, что у сотрудников реально есть): фильтр по подразделению + мульти-выбор + «добавить всех показанных» в пикере. Не вводим новый data-model employee→workshop (это отдельная крупная фича; флаг как возможный follow-up, если владельцу нужна точная привязка к цеху, а не к подразделению).

## Статус (2026-06-18)

**Весь код отгружён в `main`, проверен живым CDP-прогоном. НЕ зарелижено — ждёт `/reliz` (слот за владельцем).**
- WS-1 ✅ [#469](https://github.com/Valstan/MatricaRMZ/pull/469) (баг #5 + кисть #7 + drag-paint #8 + чип #9)
- WS-2 ✅ [#470](https://github.com/Valstan/MatricaRMZ/pull/470) (bulk-add по подразделению + мульти-выбор add/remove)
- WS-3/4 ✅ [#471](https://github.com/Valstan/MatricaRMZ/pull/471) (шрифт ± / режимы половин / растяжка / авто-fit + легенда + порядок печати)
- B (приветственное окно) — **release-time**: написать entry в `RELEASE_WELCOME_HISTORY` при `/reliz` (окно уже построено).

## Work-streams (порядок = приоритет)

### WS-1 — Взаимодействие с ячейками (КРИТИЧНО, до релиза) ✅ PR1
Файл: `TimesheetGridPage.tsx`. brain рекомендует это до релиза модуля.
- **#5 БАГ:** модалка комментария не принимает ввод. Причина: глобальный `onKeyDown` грида (на корневом `<div tabIndex>`) ловит и `preventDefault`-ит все клавиши, пока `sel` задан, а модалка отрендерена внутри того же div → буквы/цифры/стрелки уходят в грид, не в `<textarea>`. Фикс: ранний выход из `onKeyDown`, если открыта модалка (`commentEdit`/`picker`) или таргет — редактируемый элемент (`INPUT/TEXTAREA/contentEditable`).
- **#7 Кисть только выбирает:** клик по коду/часам = только `setBrush`, НЕ применять к `sel`. Убрать `if (sel) applyCode(...)` из onClick чипов. Унифицировать в одну модель «кисть» (выбор=кисть, применение=клик/протяжка по ячейке). Клавиатурный ввод (буква→код в выбранной ячейке) оставить — это ортогональный fast-path.
- **#8 Drag-paint:** `mousedown` на ячейке (старт+применить) → `mouseenter` при зажатой ЛКМ (применять) → глобальный `mouseup` (стоп). Учесть виртуализацию/выход за грид.
- **#9 Курсор=код:** плывущий «чип» кисти за курсором над гридом (надёжнее CSS `cursor:url`, нет лимита 32px/DPI). Показывать активный код/часы.

### WS-2 — Реестр: bulk-add по подразделению + мульти-выбор add/remove (A1)
Файл: `TimesheetGridPage.tsx` (пикер + строки). Backend уже готов (`addRows` массив).
- Пикер: фильтр по подразделению (departmentName) + чекбоксы/мульти-выбор + «Добавить всех показанных».
- Грид: мульти-выбор строк → групповое удаление.

### WS-3 — Шрифт + режимы отображения + растяжка по ширине (A2 + A3)
Файл: `TimesheetGridPage.tsx`.
- Базовый шрифт +2pt; кнопки ± с жёстким clamp [min..max].
- Переключатель [1-я половина][2-я половина][Месяц целиком]; растягивать на всю ширину окна.
- Авто-fit: «месяц целиком» обязан влезать без обрезки; не влезает по ширине → fallback на половину. Грабля G68 (Chromium `table-layout:auto` раздувает колонки → `width:1%`+`white-space:nowrap`).

### WS-4 — Легенда + пагинация печати + порядок (A4 + A6)
Файлы: `TimesheetGridPage.tsx` (`doPrint`/`gridHtml`/`decodeHtml`), при необходимости `printPreview.ts`.
- Легенда на экране — внизу табеля.
- Печать: табель → легенда (только если влезает) → комменты на отдельном 2-м листе (только если выбрано). Грабля G68 для fit.

### B — Приветственное окно (release-time, НЕ код)
Окно уже построено и стиль (абзацы/эмодзи/человечный язык) уже соблюдается в `RELEASE_WELCOME_HISTORY`. Действие — написать хороший operator-friendly entry при `/reliz` этого батча. Опция brain: генерить текст под релиз — на усмотрение владельца.

## Релизный слот
brain рекомендует: WS-1 (#5+#7+#8+#9) — обязательно до релиза модуля; WS-2/3/4 — можно фоллоу-апом. Слот релиза — за владельцем (`/reliz` — отдельный осознанный шаг).

## Verify
CDP e2e (skill `verify`/`verifier-electron`): живой ввод комментария + повторное открытие (значение на месте) + кисть/drag-paint + печать-снапшот. Драйвить состояние, не виджет (G43).
