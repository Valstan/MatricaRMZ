# Карточка двигателя: ширина номера, дубли, разборщики в акте дефектовки — план 2026-06

> Источник: задача владельца 2026-06-26. Четыре подзадачи по карточке двигателя и акту дефектовки. Разведка кодовой базы выполнена (4 Explore-агента) — ссылки file:line ниже.

## Контекст (что уже есть)

- **Поле «Номер двигателя»:** `EngineDetailsPage.tsx:762-774`, `style={{ width: '100%' }}` в grid-ячейке `minmax(140px,180px) 1fr` (стр. 1100).
- **Плашка дублей:** компонент `EngineDuplicateHint` (`EngineDetailsPage.tsx:42-98`), стейт `dupMatches`, дебаунс-эффект (стр. 312-333) зовёт IPC `engine:findDuplicateCandidates` → `engineService.findEngineDuplicateCandidates()` (детектор exact+similar по `normalizeLookupCompact`). Показывается всегда при ≥3 симв., и в create, и в edit.
- **Дедуп двигателей УЖЕ ЕСТЬ:** `backend-api/src/services/engineDedupeService.ts` (скан всех двигателей → группировка по `normalizeLookupCompact(engine_number)` → merge: survivor=больше операций, repoint операций, tombstone `merged_into`, soft-delete losers) + CLI `scripts/dedupeEngines.ts` (`masterdata:dedupe-engines --apply`). Эталон operator-UI — parts-dedupe (`directoryPartsDedupeService.ts`: `analyze*` + `merge*` + endpoints `/warehouse/parts-dedupe[/merge]`), но у него тоже ещё нет UI.
- **Акт дефектовки:** редактор — `RepairChecklistPanel.tsx`; данные — `RepairChecklistAnswers` (`shared/src/domain/repairChecklist.ts`) в `operations.meta_json`; печать — `engineInventoryPrintHtml.ts:buildInventoryDefectHtml()` (заголовок 216-222, подписи 257-261 через `renderSignature`). Подписи: `defect_signed_by`, `approved_by`. Пикер сотрудников — `SearchSelect` + `window.matrica.employees.list()`.

## Подзадачи и решения (технические решения приняты — см. memory «delegate technical decisions»)

### №1 — Ширина поля «Номер двигателя» (≥30 симв.)
Поле сейчас `width:100%`, в узкой ячейке схлопывается. **Решение:** задать инпуту `minWidth: '30ch'` (≈ под 30 символов моноширинно) + сохранить рост по ячейке; при необходимости расширить grid-колонку. Проверить на длинном номере («2Ж11АТ1798…»).
*Файл:* `EngineDetailsPage.tsx:762-774` (+ grid стр. 1100).

### №2 — Плашка «⚠️ Возможно, похожий» только при создании
**Решение:** гейтить **similar**-подсказку (амбер) на create-режим. Сигнал create — номер двигателя был **пустым** при открытии карточки (свежесозданный двигатель открывается с пустым номером; существующий — с заполненным). Захватить `initialEngineNumberEmpty` при открытии; similar-плашку показывать только если `true`. **Exact**-блок (красный, хард-гард дубля) оставить как есть — он защищает от сохранения дубля и на edit (write-гейт всё равно блокирует).
*Файл:* `EngineDetailsPage.tsx:42-98, 312-333`.

### №3 — Поиск дублей двигателей в списке (как parts-dedupe), найти и обезвредить старые
Merge-логика уже есть (`engineDedupeService`). Достроить **operator-driven** контур (без тихого авто-мержа — data-integrity prefer block):
- **Backend:** `analyzeEngineDuplicates()` → группы (exact + similar по `normalizeLookupCompact`, с usage-счётчиками: операции/наряды/вложения) — по образцу `analyzeDirectoryPartDuplicates`. `mergeEngines({survivorId, mergedIds, actor})` — адаптировать существующую merge-логику под **явный выбор survivor оператором** (а не авто «больше операций»). Транзакция + ledger + sync, как в parts-merge.
- **Endpoints:** `GET /engines/dedupe` (analyze, gate `engines.view`), `POST /engines/dedupe/merge` (gate `engines.edit`). + IPC-обёртки.
- **UI:** кнопка **«Поиск дублей двигателей»** в тулбаре `EnginesPage.tsx` (после превью-тоггла, стр. ~380) → модалка: группы по тирам (точные/похожие), в группе — двигатели с «Открыть» + выбор survivor + «Объединить» с **confirm** (необратимо: soft-delete + repoint).
- **Старые дубли:** обезвреживаются через эту же модалку (оператор просматривает группы и мержит). Авто-CLI `dedupeEngines.ts --apply` остаётся как массовый инструмент, но безопасный путь — UI.

### №4 — Разборщики двигателя в акте дефектовки
**Решение (хранение):** новое поле в `RepairChecklistAnswers` — `defect_dismantled_by` как **массив** `[{ employeeId, fio, position }]` (JSON в meta_json, без миграции схемы).
- **UI:** в `RepairChecklistPanel` сверху акта — секция **«Разборку двигателя произвёл:»** с `SearchSelect` сотрудника + кнопка **«Добавить сотрудника»** (несколько строк, удаление строки).
- **Печать:** в `buildInventoryDefectHtml` добавить **сверху акта** графу со списком ФИО разборщиков (+ при необходимости блок подписей каждого через `renderSignature`).
*Файлы:* `repairChecklist.ts`, `RepairChecklistPanel.tsx:1623-1674`, `engineInventoryPrintHtml.ts:210-261`.

## Поставка (3 PR, по возрастанию объёма)

1. **PR1 — быстрые правки UI:** №1 (ширина) + №2 (плашка на create). Только `EngineDetailsPage.tsx`. Низкий риск.
2. **PR2 — акт дефектовки:** №4 разборщики (model + UI + печать).
3. **PR3 — поиск дублей:** №3 (backend analyze+merge + IPC + модалка в EnginesPage).

Каждый PR — под гейтами (typecheck/lint/CI; для UI — по возможности CDP-смоук), отдельным ревью. Merge-эндпойнт (№3) и печать (№4) — адверсариальное ревью перед мержем.

## Открытые вопросы владельцу
- Нет блокирующих. Все технические развилки решены выше. Если по №3 нужен не operator-выбор survivor, а авто (больше операций) — скажи; по умолчанию делаю operator-driven с confirm.
