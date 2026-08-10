# ИИваныч: прямой движок (D-024)

Заменил облачную рутину claude.ai 2026-08-10. Раньше вопросы копились в очереди, а
контейнер в облаке раз в час забирал их по REST и писал ответы; теперь на вопрос
отвечает сам бэкенд прямым вызовом DeepSeek API — за десятки секунд, без расписания
и без включённого компьютера владельца.

## Как это работает

1. Клиент пишет вопрос в свою реплику (`ai_chat_requests`, статус `pending`) и **сразу**
   пинает синк — ждать пятиминутный авто-тик незачем.
2. Воркер `services/ai/aiChatAnswerService.ts` (тик 2 с, только на primary-инстансе)
   забирает вопрос, ставит `processing` — клиент показывает «ИИваныч думает».
3. Движок ходит в БД read-only тулами (`services/ai/llmTools.ts`) **правами автора
   вопроса**: чужие данные и скрытые поля недоступны так же, как в UI.
4. Ответ пишется тем же ledger-путём, что писала рутина (`aiChatWriteService`), и
   приезжает клиенту обычным pull'ом. Пока вопрос в работе, панель тянет ответ каждые
   2,5 с.

Статусы вопроса: `pending` → `processing` → `answered` | `escalated` | `rejected`.

## Движок и ключи

| Переменная | Смысл |
|---|---|
| `MATRICA_AI_PROVIDER` | `deepseek` (по умолчанию) или `anthropic` |
| `MATRICA_AI_DEEPSEEK_API_KEY` | ключ DeepSeek; fallback — `DEEPSEEK_API_KEY` |
| `AI_MODEL_CHAT` / `AI_MODEL_ANALYTICS` | оверрайд моделей (по умолчанию `deepseek-v4-flash` / `deepseek-v4-pro`) |
| `AI_CHAT_ANSWER_*` | таймаут, потолок токенов, шагов и попыток на один ответ |

DeepSeek держит **Anthropic-совместимый эндпойнт** (`https://api.deepseek.com/anthropic`),
поэтому используется тот же `@anthropic-ai/sdk` и тот же контур тулов — меняются только
baseURL, ключ и имя модели. Anthropic оставлен переключателем, но с РФ-IP он режется на
эдже, поэтому боевой движок — DeepSeek.

Ключ живёт в комнате `matricarmz` менеджера секретов KARMAN и попадает на прод в
`/etc/matricarmz/matricarmz.env`. В Git ключей нет — репозиторий публичный.

## Тулы сверх БД-набора

- `escalate_to_admin(reason)` — движок не может ответить (нет данных, не хватает прав,
  нужно управленческое решение): вопрос уходит в `escalated`, суперадмин получает DM и
  даёт вердикт, после чего вопрос обрабатывается снова уже с вердиктом в промпте.
- `attach_table(filename, columns, rows)` — ответ файлом `.xlsx` (`services/ai/answerWorkbook.ts`,
  exceljs). DOCX и PDF прямой движок не умеет — эти чипсы из UI сняты.

## Правила ответов

Живая «конституция» — в `ai_chat_meta.rules_md`, история правок — `ai_chat_rules_history`.
Читает её движок при каждом ответе, правит владелец:

```bash
corepack pnpm -C backend-api ai:rules get > current.md
corepack pnpm -C backend-api ai:rules set docs/ai-chat/RULES.seed.md
```

## Что делать, если ИИваныч молчит

1. `/health` → `features.aiEnabled` и `/ai-chat/meta` → `ready`. `ready:false` = нет ключа
   движка или `AI_ENABLED=false`; вопросы при этом копятся и разберутся после настройки.
2. Лог бэкенда. **На проде `logInfo` подавлен** (`utils/logger.ts`: вне dev печатаются только warn/error/critical), поэтому в journald видны лишь `ai chat direct worker started` (помечен critical) и `ai chat direct: answer failed`. Успешные `answered`/`escalated` — только в dev-режиме.
3. Вопрос завис в `processing` — воркер вернёт его в очередь через 10 минут
   (`AI_CHAT_DIRECT_STALE_MS`); три неудачные попытки подряд переводят вопрос в
   `escalated` с технической причиной, чтобы не крутить цикл.
4. Ответ есть в БД, но не виден в клиенте — смотреть синк, а не движок: сверить
   `serverCursor` с `serverLastSeq` в `sync.status()`.
