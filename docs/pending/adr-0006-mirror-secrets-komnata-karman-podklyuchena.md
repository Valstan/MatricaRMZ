# ADR-0006 mirror-secrets — комната KARMAN подключена, зеркалирование не сделано 🗓 since:2026-06-30 🟡

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «⏳ Ждёт внешнего окна / события»

Ратифицирован cross-project ADR-0006: каждый проект обязан зеркалить секреты/токены/ключи в KARMAN-vault.

**2026-08-10 (D-024):** онбординг наконец состоялся — владелец выпустил одноразовую времянку `skb_…`, обмен на `POST /api/secrets/claim` дал постоянный **read-only** токен комнаты `matricarmz`. Токен лежит в `/etc/matricarmz/matricarmz.env` как `SECRETS_TOKEN`; из комнаты прочитан `DEEPSEEK_API_KEY`. Гайд — `../karman/docs/secrets-client-guide.md`.

Что осталось:

1. **Vault-клиент в бэкенде** (D-024 просил именно его): читать секреты по allowlist имён на старте с фолбэком на локальный env. Сейчас ключ просто лежит в env — работает, но ротация ручная.
2. **Зеркалирование НАШИХ секретов в комнату** — нужен rw-токен (наш read-only не пишет): прод `.env`, `/etc/matricarmz/matricarmz.env`, ledger-ключи, `MATRICA_LEDGER_RELEASE_TOKEN`, `YANDEX_DISK_TOKEN`.

Заодно KARMAN отозвал rw-токен `skm_uwc8idh0` нашей комнаты — выпущен 29.06, ни разу не использован, потерялся при доставке.
