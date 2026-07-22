# План: Асинхронный чат с нейросетью (queue-based AI chat)

> После одобрения первым шагом скопировать этот план в `docs/plans/ai-chat-async-2026-07.md` (правило CLAUDE.md — планы живут в репо).

## Context

В клиенте есть кнопка AI-чата (`AiAgentChat.tsx` + `ai_chat_history`), сейчас отключена: синхронный вызов Anthropic API дорог и гео-блокирован из РФ. Переделываем в **асинхронную очередь**: оператор пишет вопросы в клиенте (лимит 5/час, редактируемы до ответа, можно прикрепить файл), а **облачная рутина Claude** (scheduled agent, как на Сарафане — решение владельца 2026-07-19) раз в час **Пн–Пт 8:00–17:00 МСК** заходит на прод по SSH, читает все ожидающие вопросы, анализирует БД (read-only) и пишет ответы, которые синком приезжают в клиенты. Ответы учитывают **права роли спросившего** (не выдавать данные из закрытых для него разделов). Файлы ответов — через Яндекс.Диск (существующий `file_assets`-контур). Непонятные/рискованные вопросы рутина **эскалирует суперадмину**, его вердикты копятся в **файл правил** («конституция ответов»), который рутина читает на каждом запуске. Backend Anthropic API **не** вызывает — существующий sync-путь (`claudeProvider.ts`/`chatService.ts`) остаётся выключенным.

## Архитектура (решения)

1. **Новая synced-таблица `ai_chat_requests`** (одна строка = пара вопрос→ответ), НЕ реюз `chat_messages` (нет статусов/редактирования/пейринга):
   - `id, user_id, username, question_text, question_file_id (→file_assets), status ('pending'|'answered'|'escalated'|'rejected'), answer_text, answer_files_json, answered_at, escalation_note, verdict_text, created_at, updated_at, deleted_at, sync_status` + индексы `(user_id, created_at)`, `(status)`.
   - Плюс не-синкуемая серверная `ai_chat_meta` (key/value): `last_run_at`, `rules_md`; история правил — append-only `ai_chat_rules_history`.
2. **Один путь записи — через sync** (клиент SQLite → push), офлайн-совместимо. Серверный **push-guard** (рядом с `restrictedWorkOrders`-прецедентом в `applyPushBatch.ts`): актор = `user_id`; ≥5 строк/час → reject; edit/delete только при `status='pending'`; исключение — суперадмин пишет `verdict_text` в escalated-строки. Приватность pull: строка видна владельцу + admin bypass (`syncPrivacy.ts`).
3. **Баннер «когда ответит ИИ»**: расписание детерминировано → `shared/src/domain/aiChatSchedule.ts` (`getNextAiRunAt`, МСК = фикс UTC+3, Пн–Пт 8–17, границы Пт 17:00 → Пн 8:00); «последний запуск» — из `ai_chat_meta` через тонкий `GET /api/ai-chat/meta` (новый `routes/aiChat.ts`).
4. **Runner-скрипт на проде** `backend-api/src/scripts/aiChatRoutineIO.ts` (компилируется в dist, зовётся рутиной по SSH; JSON-вывод). Команды:
   - `list-pending` — вопросы + на каждого пользователя: `getEffectivePermissionsForUser` + `buildAllowedTablesFromPerms` + роль + download-href файла вопроса;
   - `post-answer --id … --answer-file … [--attach …] --expect-updated-at …` — залив вложений на Яндекс (`yandexDisk.ts`) → `file_assets` → запись ответа через `recordSyncChanges` (актор — реальный employee `ai-agent`, `allowSyncConflicts`; гочи из memory); отказ, если вопрос отредактирован после list-pending;
   - `escalate --id … --reason-file …` — статус + DM суперадмину (паттерн `sendReportToSuperadmin`, `aiAgentReportsService.ts:315-353`);
   - `get-rules` / `set-rules --file …` — правила в БД (`ai_chat_meta.rules_md`, переживает деплой, попадает в бэкап) + история; seed в репо `docs/ai-chat/RULES.seed.md`;
   - `mark-run`.
   Все **записи** — только через runner (ledger/sync); **чтения** рутина может делать прямым psql, но под выделенной PG-ролью `ai_readonly` (SELECT-only grants) — LLM физически не может писать мимо ledger.
5. **Файлы**: вопрос — клиент реюзает поток `sendChatFile` (`/files/yandex/init` → PUT → `file_assets` → `question_file_id`); ответ — runner заливает с прода. Новый entity-scope `ai_chat` в `fileAccessService.ts`: файл читаем владельцем запроса + админами.
6. **Права в ответах**: runner отдаёт рутине карту прав/allowed-tables спросившего; промпт рутины требует отвечать только по доступным доменам, при сомнении — эскалация. Вердикты: суперадмин видит эскалации в том же UI, заполняет `verdict_text` → sync → следующий запуск рутина отвечает по вердикту и дистиллирует правило в RULES (`set-rules`).
7. **UI**: переработка `AiAgentChat.tsx` на месте (за `chat.use`): убрать SSE; список своих запросов из локальной SQLite как Q→A-карточки со статусами (⏳/✅/⚠️), композер с файлом, edit/delete у pending, счётчик «осталось N из 5», баннер след./посл. запуска, download-чипы у ответов; у суперадмина — фильтр «эскалации» + поле вердикта. CRUD — через generic sync-write IPC (как чат/заметки), HTTP-IPC остаётся только `aiChat.meta`.
8. **Определение рутины** — `docs/ai-chat/ROUTINE.md` (версионируется), текст переносится в claude.ai scheduled agent. Cron `0 5-14 * * 1-5` UTC. Цикл: get-rules → list-pending → по каждому вопросу анализ read-only SQL с учётом прав → post-answer / escalate → вердикты → set-rules → mark-run. Автономно, без подтверждений владельца.

## Фазы (по PR)

1. **Модель + sync-плюмбинг**: `shared/src/sync/{tables,dto,registry}.ts`, `shared/src/domain/ledgerAuthz.ts`, `backend-api/src/database/schema.ts` + drizzle-миграция, `electron-app/drizzle/` SQLite-миграция, `syncPrivacy.ts`/`pullChangesSince.ts`, таблицы `ai_chat_meta`(+history). Гейты: assertSyncMapCoverage, checkSyncContract, typecheck.
2. **Push-guard**: `aiChatPushGuard.ts` рядом с `restrictedWorkOrders.ts` (ownership, 5/час в одной транзакции, pending-only, verdict-исключение) + unit-тесты по образцу `ledgerAuthzGuard.test.ts`.
3. **UI клиента**: `AiAgentChat.tsx` rewrite, `shared/src/domain/aiChatSchedule.ts` (+тест границ МСК), файл вопроса, `routes/aiChat.ts GET /meta`, чистка IPC (`register/aiAgent.ts`, `shared/src/ipc/types.ts`). exactOptionalPropertyTypes — conditional spread.
4. **Runner + file authz**: `scripts/aiChatRoutineIO.ts`, bootstrap employee `ai-agent`, `fileAccessService.ts` scope `ai_chat`, залив ответ-файлов. Smoke на dev-БД: pending → post-answer → клиент получил по pull.
5. **Эскалация + вердикты + правила**: `escalate`, verdict-UI суперадмина, get/set-rules + история, `docs/ai-chat/RULES.seed.md`.
6. **Рутина + раскатка**: `docs/ai-chat/ROUTINE.md`, создание scheduled agent (владелец/я через /schedule), деплой, первый supervised-запуск, PG-роль `ai_readonly` на проде, затем автономно.

## Верификация

- Пофазно: build shared+ledger → `pnpm -r typecheck` + lint (последовательно, memory про dist-race) → `pnpm -F backend-api test` (guard/privacy/schedule) → checkSyncContract.
- E2E (verifier-electron, CDP): открыть AI-чат, отправить вопрос (+файл), убедиться push; выполнить `aiChatRoutineIO.js post-answer` против dev-backend → ответ + чип файла отрисовались после sync; 6-й вопрос за час отклонён с тостом.
- Прод-раскатка: обычный релизный контур; первый запуск рутины — под присмотром.

## Риски / гочи

- Актор runner'а — реальный employee `ai-agent` (presence-FK) + `allowSyncConflicts` (memory `server_script_sync_write_gotchas`).
- PG-роль `ai_readonly` — гарантия «только чтение» для прямых SELECT рутины.
- Rate-limit гонка — считать внутри транзакции push-guard.
- МСК — фикс UTC+3, без Intl/DST.
- Runner в `dist/` — первым делом печатает версию/health (деплой мид-флайт).
- Редактирование вопроса после чтения рутиной — `--expect-updated-at` в post-answer.
- Стоимость: рутина в рамках подписки claude.ai, API-ключ не нужен; при пустой очереди запуск дешёвый (list-pending → exit).
