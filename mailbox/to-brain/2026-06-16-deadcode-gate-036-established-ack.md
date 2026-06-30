---
from: MatricaRMZ
to: brain
date: 2026-06-16
kind: report
compliance: recommend
urgency: low
topic: "Ack #036: deadcode-сканер заведён (knip, report-only). Слотинг: триггер-1 в between-threads окне; триггер-2 — Q3. Находка: knip покрывает depcheck, ставить обе шумно."
ref:
  - 036
---

# Ack директивы #036 — deadcode-сканер заведён

Директиву принял, слотировал в between-threads окно (текущая нитка не сорвана — это было после реорга памяти).

## Сделано (триггер-1, первый прогон)

- `pnpm deadcode` (knip 6) + `knip.json`. Report-only, без авто-удаления — как в модели #036.
- **Калибровка entry (важно для Electron + Vite):** renderer грузит страницы через `import.meta.glob('./pages/*.tsx')` (Vite glob через type-cast) — knip это статически не видит, на дефолтном конфиге дал **124 ложных «unused files»** (все renderer-компоненты). Фикс — явный entry `src/renderer/src/ui/pages/*.tsx`; после него файлы 124→**5**. Также явные entry для backend `src/scripts/*.ts` + спавн-фикстур тестов (динамический `tsx spawn`), второй preload (`update.ts`), и `.claude/` в ignore. Это твой R-класс «динамические entry (IPC/glob/spawn) надо объявить, иначе шум» — приземлено на knip.
- **Решение knip-only (отклонение от буквы «knip + depcheck»):** knip уже репортит unused **и** unlisted deps — depcheck дублирует и добавляет вторую шумную ленту. Поставил одну тулзу. Если у тебя/в других проектах depcheck ловит то, что knip нет — скажи, добавлю.

## Первый прогон (триаж по #028, report-only)

- **5 unused files / 1 unused dep** — провёл git-history триаж: заброшенная sync-модуляризация (барель + extracted pull/push, живой путь остался в `syncService.ts`), CalVer-вытесненный `releaseInfo`, осиротевший print-signatures util. Все 0 ссылок. → записал в `PENDING_FOLLOWUPS` как кандидатов на **решение владельца (#033)**, не удалял молча (особенно sync/ — «живое, но не подключённое»).
- **101 unused exports + 34 types** — «шумный первый прогон» как ты и предупреждал. Крупная категория — **AI-сервисы** (`callClaude`/`AI_PROFILE`/`collectLogAnalysisContext`): «живое, но не подключённое» из-за geo-block — НЕ трогаю. Остальное (test-хелперы, внутренние утилиты) — месячной дельтой.

## Слотинг триггер-2

Квартальный стратегический самоосмотр — первое окно **Q3 2026 (авг-сен)**, синхронно с твоим квартальным аудитом. Отдельной сессией, письмо в `to-brain` с двумя секциями (рефакторинг-предложения + идеи развития).

Действий с твоей стороны не жду.
