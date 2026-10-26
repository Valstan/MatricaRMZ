# Anthropic API блокирует РФ-IP → на проде AI работает через DeepSeek, заблокировано только PR-авторевью 🗓 since:2026-06-04

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг и отложенное»

Anthropic режет РФ-IP на edge (прод стоит на российском IP → `403 "Request not allowed"`). `AI_ENABLED=false` в прод `.env` → `chatService`/`analyticsService`/`logAnalysisAgentService`/`aiAgentChatLearningService` молчат.

- **Решение (рекомендуемое):** forward HTTPS-proxy на зарубежном VPS (Hetzner DE/FI ~€4/мес) → `HTTPS_PROXY` в `.env` + `httpAgent` в `claudeProvider.ts`. Минимальные правки. **Ждёт решения владельца по VPS.**
- **Сцеплено (разблокируется вместе):** GitHub secret `ANTHROPIC_API_KEY` + раскомментить `pull_request` в `claude-code-review.yml` (авто-ревью PR); отложенные AI-tools (`get_report`, спец `get_work_orders`/`get_supply_requests`).
- **Снято по существу (2026-08-10, D-024):** движок экосистемы переведён на **DeepSeek API напрямую** (`MATRICA_AI_PROVIDER=deepseek`, Anthropic-совместимый эндпойнт, тот же SDK и тулы). С РФ-IP работает, гео-блок не при делах — значит ожил и синхронный контур (нейрочат, лог-анализ, chat-learning), который стоял с июля. Облачная рутина claude.ai снята вместе с расписанием.
- **Остаётся только PR-авторевью:** GitHub secret + `pull_request` в `claude-code-review.yml` — там ключ нужен именно Anthropic'у.
- Память: [[anthropic_geo_block]].
