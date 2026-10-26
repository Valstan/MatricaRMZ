# Джоб chat-learning пишет корпус, которого никто не читает 🗓 since:2026-08-30 🟢

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟢 Отложенные фазы / route /zavod»

При исполнении R29 пошли оптимизировать префикс модуля `chat-learning` из списка мандата — и выяснили, что [`aiAgentChatLearningService.ts`](../backend-api/src/services/aiAgentChatLearningService.ts) **вообще не обращается к нейросети**: раз в 10 минут читает `chat_messages` и кладёт JSON-снимок в `diagnostics_snapshots` (scope `ai_agent_chat_corpus`). Потребителя снимка в коде не нашлось.

Либо у корпуса был потребитель, снятый вместе с облачной рутиной (D-024), либо он и не появился. Решение владельца: снести джоб или довести до потребителя. Пока просто пишет в базу каждые 10 минут.
