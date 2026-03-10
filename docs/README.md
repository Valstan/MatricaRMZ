# MatricaRMZ Docs

Документация приведена к рабочему минимуму, чтобы новая сессия разработки (в том числе с ИИ-агентом) быстро входила в контекст без поиска по лишним файлам.

## С чего начинать
- Общая карта проекта, запуск, ENV, логи и ключевые команды: [`OPERATIONS.md`](OPERATIONS.md)
- Локальная разработка на Windows 11 + MCP-доступ к VPS: [`WINDOWS_DEVELOPMENT.md`](WINDOWS_DEVELOPMENT.md)
- Если есть инцидент с синком/деплоем: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
- Если задача про обновления/релизы: [`RELEASE.md`](RELEASE.md)
- Если задача про отчеты: [`REPORTS.md`](REPORTS.md)
- Если задача про ledger/sync архитектуру: [`BLOCKCHAIN.md`](BLOCKCHAIN.md)

## Профильные документы
- Безопасность и секреты: [`SECURITY.md`](SECURITY.md)
- UI-стандарты renderer: [`UI_VISUAL_STANDARDS.md`](UI_VISUAL_STANDARDS.md)
- Складской модуль: [`WAREHOUSE.md`](WAREHOUSE.md)
- AI/Ollama профили: [`AI_PERFORMANCE_PROFILES.md`](AI_PERFORMANCE_PROFILES.md)

## Правило поддержки актуальности docs
- Обязательная политика обновления документации при изменениях в коде: [`DOCUMENTATION_POLICY.md`](DOCUMENTATION_POLICY.md)
- Коротко: любой значимый change в архитектуре, update-flow, отчетах, ENV, скриптах или эксплуатационных шагах должен сопровождаться обновлением документации в той же сессии/PR.

## Базовые инварианты системы
- Синхронизация клиента только через ledger-эндпоинты: `POST /ledger/tx/submit`, `GET /ledger/state/changes`.
- Legacy `sync/*` не используется в рабочем контуре.
- Релиз клиента для автообновлений должен быть опубликован в ledger с корректными `version`, `fileName`, `size`, `sha256`.
- Секреты (`.env`, токены, ключи) не храним в репозитории.


