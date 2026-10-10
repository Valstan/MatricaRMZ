# Унификация актов и этапов: список этапов выводит из акта (2026-10)

Программа владельца, п.3 (согласован 10.10.2026): «дефектовка и комплектность вводились из двух
мест (акт = операции, этапы = строки единого списка) — сделать так, чтобы это был один документ:
список этапов выводит из акта без дублей».

## Что сейчас (факты, 10.10.2026)

- Акт — один живой лист `engine_inventory` (`checklistService`, `operation_type='engine_inventory'`).
  Даты акта: `answers.arrival_date`, `answers.completeness_inspection_date`, `answers.defect_start_date`.
- Проведение акта пишет этап **вторым документом вдогонку**: `conductCompleteness` → `stages.save(arrival)`,
  `conductDefect` → `stages.save(disassembly_defect)` (клиент, mark-if-absent вручную через `stages.list`,
  `RepairChecklistPanel.tsx:829-865`). Этап может разойтись с актом (дата, удаление, второй проход).
- Единый список (`repair_history_entry`, `entryType: stage|sheet|manual|...`) читают: лента карточки
  (`buildEngineHistoryFeed`), список «Этапы работ» (`listWorkSheetRows` — оба origin), метки этапов
  (`getEngineRepairHistoryMap.stageCodes`, `loadEngineStageMarks`), `currentDatedStage`, countdown.
- Обратная подсказка (дата ручного этапа → пустое поле акта) остаётся — она про ручной ввод, не про вывод.

## Цель

Проведение акта — единственная запись факта. Этапы `arrival` и `disassembly_defect` в едином списке
**выводятся из акта** (derive-on-read), отдельные stage-строки этих кодов больше не пишутся.
Дубль по построению невозможен: один код + один московский день = одна запись.

## Правила вывода (домен, чистые функции)

- `actStageEntries(actDates) → [{code:'arrival'|'disassembly_defect', atMs, origin:'act'}]`:
  `arrival` ← `completeness_inspection_date ?? arrival_date`; `disassembly_defect` ← `defect_start_date`.
  Без даты — нет записи (этап-план не выводим, как и везде).
- `mergeActStages(stored, derived)`: один код + один московский день (`moscowDayKey`, как гейт
  дублей `isSameWorkSheetDay`) = одна запись; при совпадении показывается **выведенная**
  (акт — источник правды), stored-строка того же дня скрывается. Stored-строки других дней
  остаются (ручные правки/история — их не трогаем, не удаляем).
- Ручной ввод этапов этих кодов остаётся доступен (оператор может отметить вручную без акта);
  запись идёт как раньше через `saveRepairStageRow` со всеми гейтами.

## Шаги (один шаг — один PR)

1. **Домен (shared):** `actStageEntries` + `mergeActStages` + тесты (дедуп same-day, бездатые,
   разные дни не схлопываются, `origin:'act'`). Без читателей — только функции.
2. **Читатели main:** применить слияние в `stages:list` (лента), `listWorkSheetRows` (список этапов),
   `getEngineRepairHistoryMap` (ступень «Есть этап»), `loadEngineStageMarks` (списки/массовый диалог/
   «Этап на заводе»). Даты акта брать из последнего `engine_inventory` (там же, где
   `getEngineInventoryFlagsMap` уже читает тела актов).
3. **Писатели:** убрать вдогонку `stages.save` из `conductDefect`/`conductCompleteness`
   (этап теперь выводится сам); статусные строки («Этап отмечен») — тоже. Обратную подсказку
   (этап → пустое поле акта) оставить.
4. **Web-admin:** тот же вывод в дубле `RepairChecklistPanel` (проверить, что вдогонки там нет;
   если есть — убрать).

## Что НЕ делаем

- Не удаляем и не мигрируем старые stored-строки этих кодов — их гасит дедуп same-day.
- Не трогаем `scrap_branch`, `obkatka` (след `completesRepair`), `sborka` (наряды), sheet-строки.
- Не меняем складскую проводку `conductDefect` и версионирование — только довесок этапов.
- EAV-freeze: новых атрибутов нет, всё из существующих `meta_json`.

## Приёмка

- CDP-смоук: провести комплектность → `arrival` в ленте и списке этапов без второй записи;
  провести дефектовку → `disassembly_defect` с датой акта; повторная проводка другим числом —
  этап едет за актом, дубля нет; ручной этап тем же днём не дублируется.
- Unit: домен шага 1 + регресс существующих сторожей этапов.
- Прод не трогаем до релиза; миграций БД нет.
