# Живая приёмка нитки #176, разрез 1 — строка статуса локального звена

**Дата:** 2026-11-27 · **Стенд:** `lane1` (backend 3002, БД `matricarmz_dev_lane1`, renderer 5174, CDP 9223)
**Драйвер:** `.claude/skills/verifier-electron/scripts/cdp-ivanych-status-line.mjs`
**Итог:** **6/6 PASS**

## Что проверялось

Строка статуса локального звена ИИваныча в панели на жистом клиенте:

- строка вообще есть и непустая;
- в ней **нет ни кодов причин, ни служебных слов** (регулярка ловит `no_free_accounts`,
  `no_tokens_ready`, `no_handable_accounts`, «Карман», «пул», «токен», «MiniMax», «агент», `HTTP`);
- текст строки берётся **из дома** (`AI_CHAT_ENGINE_UNAVAILABLE_LINE` в
  `shared/src/domain/aiChatSchedule.ts`), а не из компонента.

## Что стенд НЕ показал (и почему)

На стенде выключен движок ИИваныча — в `/health` ответа `matricarmz_dev_lane1`:
`"features":{"aiEnabled":false}`. Поэтому панель показывает ветку «не отвечает никто»
(«🔴 ИИваныч сейчас недоступен: вопрос сохранится и будет обработан позже»), а локальная ветка
статуса на этой машине **не наблюдаема**.

Локальная ветка (перебор аккаунта, различение причин пустоты, тишина) закрыта **юнит-тестами**:
`electron-app/src/main/services/localMiniMax/localMiniMaxEngine.test.ts` (16),
`shared/src/domain/aiChatSchedule.test.ts` (8),
`electron-app/src/main/services/localAiChatBoundary.guard.test.ts` (+6 правил).

Живая приёмка локального звена (машина с настроенным рантаймом MiniMax и аккаунтами пула) —
за владельцем; на стенде её взять нечем.

## Отчёт

[`cdp-ivanych-status-line-report.json`](cdp-ivanych-status-line-report.json)
