# Мост «очередь ИИваныча ↔ Телефон» — план

> Мандат brain `2026-10-05-iivanych-hotline-bridge` (D-111, compliance mandate,
> срок 12.10, `ack: report`). Пока DeepSeek не оплачен, на вопросы операторов
> отвечает живая сессия через Телефон; DeepSeek — fallback, не конкурент.
> Размещение — у нас в коде, без новых секретов и чужих доступов к базе.

## Что уже есть (разбор 05.10, фактическое)

- Очередь: `ai_chat_requests` (`backend-api/src/database/schema.ts:728`), статусы
  `pending/processing/answered/escalated/rejected`. Прямой движок
  (`services/ai/aiChatAnswerService.ts`) тикает каждые 2 с, забирает ВСЕ `pending`
  (`listPending`, `:420`) через неатомарный `claim()` (`:184`, read-modify-write
  по ledger-пути — безопасен только пока воркер один в процессе).
- Сейчас движок простаивает честно: `aiChatDirectTick` (`:438`) сразу возвращает
  `{processed: 0}`, если LLM не сконфигурирован. Конкурента у моста пока нет —
  гонка за строки возникнет, только когда оплатят DeepSeek.
- Все серверные записи в sync-таблицы — только через `writeSyncChanges`
  (`services/ai/aiChatWriteService.ts:66`); прямой SQL-write в `ai_chat_requests`
  запрещён (иначе строка невидима инкрементальному pull).
- `aiChatMeta` (`schema.ts:759`) — служебный key/value, НЕ синкается. PK на `key` —
  готовый атомарный CAS для claim'а без миграций.
- TG-пламбинг для пейджинга готов: `sendTelegramMessageToChat`
  (`services/telegramBotService.ts:234`), чат — `MATRICA_TELEGRAM_ALERT_CHAT_ID`
  (тот же, что у critical-events, `criticalEventsTelegramService.ts:55`).
- Контракт релея (каноник — `karman docs/hotline-relay.md`, код —
  `karman/app/api/hotline/route.ts`, `presence/route.ts`, `lib/hotline/service.ts`):
  `POST /api/hotline {from,room,kind,text}` + Bearer → `201 {id, created_at}`;
  `GET /api/hotline?room=&since_id=&limit=` → `200 {messages:
  [{id,room,sender,kind,text,createdAt}]}`; `POST /api/hotline/presence
  {label, alive_minutes}` → 201; `GET /api/hotline/presence` (тоже по Bearer) →
  `{presence: [{label, aliveUntil, updatedAt}]}`. Комнаты: `to-<метка>` / `all`;
  наша — `to-MatricaRMZ`. Лимит текста 2000, серверный линт режет секретоподобное
  (400 — не сеть, а отказ в приёме). Fail-closed 503 без секрета.
- Секреты `HOTLINE_RELAY_SECRET` / `HOTLINE_RELAY_URL` — только env/рантайм
  (те же имена, что у `hotline.sh`), никогда в репо. На PC79 оба ключа уже есть
  в машинном хранилище (сторона brain) — в backend-env их нет, это нормально.
- Фоновые джобы — только primary (`backend-api/src/index.ts:98-117`,
  `shouldRunBackgroundJobs`); мост встаёт туда же, вторым таймером рядом с
  `startAiChatDirectWorker()`.

## Решение по спорным точкам

1. **Claim без миграций — строкой в `aiChatMeta`.** Ключ
   `hotline_bridge_claim:<uuid>`, значение — JSON `{claimedAt, relayMsgId,
   postedAt, pagedAt}`. Вставка по PK — атомарный CAS: конфликт = гонку
   проиграли, строку пропускаем. Статус строки всё время `pending` — fail-open
   (п.4) сводится к удалению ключа, ledger-путь не дёргается зря, sync-контракт
   и реплика клиента не меняются. Отвергнуто: новая колонка `bridge_claim_at`
   (миграция + sync-payload + реплика Electron + EAV-freeze-спор) и
   `status='processing'` (клиент покажет ложное «думает», а `reclaimStale`
   через 10 мин украдёт строку обратно).
2. **Единственное касание движка DeepSeek — фильтр в `listPending`.**
   Исключить id, у которых есть claim-ключ (один запрос в `aiChatMeta` за тик).
   Остальное в `aiChatAnswerService.ts` не трогаем (п.6 мандата).
3. **Мост НЕ шлёт heartbeat presence от метки `MatricaRMZ`.** Иначе присутствие
   всегда свежее и пейджинг (п.2) не сработает никогда. Живость сессии читаем
   только relay-GET'ом.
4. **Таймаут X = 30 мин** (старт по мандату; крутится env'ом
   `AI_CHAT_BRIDGE_TIMEOUT_MS`).
5. **Ответ засчитывается только от `sender == MatricaRMZ`** (регистр неважен),
   `kind ∈ {answer, done}`, текст содержит `#<uuid>` заявленной строки. Свои
   посты (`kind=question`, префикс `[ИИваныч #…]`) под фильтр не попадают.
   Чужие метки и строки без `#id` игнорируются. Первый ответ закрывает вопрос,
   опоздавшие дубли по тому же `#id` — мимо (строка уже не `pending`).
6. **Отказ релея в приёме (400 линт) — не сеть.** Claim снимаем сразу, строка
   возвращается в `pending` (под DeepSeek, когда будет), в лог — причина.
   Ретраи — только на сеть/5xx/429.

## Работы (все — backend, миграций нет)

### B1. Relay-клиент `backend-api/src/services/ai/hotlineRelayClient.ts`
- `relayPost({room, kind, text})` → `{id}`; `relayRead({room, sinceId})` →
  сообщения; `relayPresence()` → список. Bearer из env, таймауты + 1 повтор на
  сетевой отказ (паттерн `telegramFetch`). 400/401/503 — честные ошибки наверх,
  не повторы. Основание — контракт выше, не `hotline.sh` (bash-скрипт сессии,
  не зависимость сервера).
- Env: `HOTLINE_RELAY_SECRET`, `HOTLINE_RELAY_URL` (обязательны; без них воркер
  стартует в no-op с `warn` раз при старте — вопросы ждут как сегодня).

### B2. Воркер `backend-api/src/services/ai/aiChatHotlineBridgeService.ts`
- `startAiChatHotlineBridge()` в `index.ts:114` рядом с движком, только
  `runBackgroundJobs`. Тик `AI_CHAT_BRIDGE_TICK_MS` (дефолт 30 с), guard
  единственного тика в полёте (паттерн `running`, как у движка).
- За тик по порядку: (а) подобрать до N (дефолт 5) `pending` без claim'а, claim
  вставкой в `aiChatMeta`, пост в relay комнатой `to-MatricaRMZ` текстом
  `[ИИваныч #<uuid>] <вопрос, обрезанный до 2000>` (+ строка про приложенный
  файл, если `question_file_json` — файл сессия смотрит в программе);
  (б) прочитать новые сообщения (`since_id` = курсор из `aiChatMeta`
  `hotline_bridge_cursor`; на первом старте курсор = max id без обработки);
  совпавшие ответы → `writeAiChatRow` статусом `answered` (штатный finish-путь:
  `answerText`, `answeredAt`, `updatedAt`) + снять claim;
  (в) просроченные claim'ы (старше X) → снять claim (fail-open), в лог;
  (г) по заявленным без свежего присутствия `MatricaRMZ` → один TG-алерт
  (`pagedAt`, текст — только счёт и id, без текста вопросов и секретов).
- Присутствие свежим считается при `aliveUntil > now + 60 с` (часы плывут).

### B3. Фильтр claim'ов в `listPending` (`aiChatAnswerService.ts:420`)
- Исключить id из `aiChatMeta` с префиксом `hotline_bridge_claim:`. Одна строка
  комментария — почему (мост D-111).

### B4. Тесты (рядом с сервисами, моки fetch)
- CAS claim'а: второй claim того же id проигрывает (PK-конфликт).
- Сопоставление ответов: свой `question`-пост не матчится; чужая метка и текст
  без `#id` игнорируются; первый `answer` закрывает, повтор — мимо.
- Fail-open: claim старше X снимается, статус остаётся `pending`.
- Пейджинг: присутствие свежее → тишина; протухшее → один алерт, текст без
  вопроса; повторный тик — без дубля.
- Курсор: первый старт не пережёвывает историю.

### B5. Доки и приёмка
- `docs/OPERATIONS.md`: `HOTLINE_*` + `AI_CHAT_BRIDGE_*` — только имена и
  назначение (значений нет нигде в репо). `docs/machines/PC79.md`: как
  тестировать мост со стенда (секреты — из машинного хранилища в `.env.dev`
  руками владельца).
- Гейты: `typecheck`, `lint`, полный `test` backend + CI зелёный. Миграций нет —
  `db:migrate` не нужен. UI не тронут — CDP-смоук не требуется.
- `ack: report` письмом в `mailbox/to-brain/` (`ref:
  2026-10-05-iivanych-hotline-bridge`): мост на проде + dry-прогон (вопрос →
  релей → тестовый ответ → `answered` видно клиенту) + TG-алерт проверен живьём
  + грант «Действует» (GET presence 200 нашим секретом).

## Зависимости от владельца (вне кода, критический путь)

1. **Секрет для прода.** Accept гранта в комнате `matricarmz` (propose — за
   КАРМАНом): наш токен на боксе read-only — если accept нечем, закрываем
   GUI-приёмом или времянкой, строкой Мозгу. Затем значения — в env-файл
   прод-сервиса + рестарт primary. Без этого B1/B2 на проде — честный no-op.
2. **Доступность релея с прод-бокса** — доказывается dry-прогоном; при
   недоступности мост ждёт, вопросы копятся как сегодня (регресса нет).
3. **Живой TG-алерт для приёмки** — договориться о моменте (сессия спит или
   тестовый текст с пометкой ТЕСТ), чтобы не будить владельца вхолостую.
4. X=30 мин и текст префикса `[ИИваныч #id]` — подтвердить (предложены выше).

## Порядок

B1 → B2 (+B3 тем же PR, это одна нитка) → B4 в том же PR → гейты → merge →
секрет в прод-env + рестарт → dry-прогон с живой сессией → `ack: report`
письмом. Срок 12.10 держится: кода на 1–2 сессии, остальное — координация.
