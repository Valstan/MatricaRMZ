# MatricaRMZ Docs

Документация приведена к рабочему минимуму, чтобы новая сессия разработки (в том числе с ИИ-агентом) быстро входила в контекст без поиска по лишним файлам.

## Управление сессией и git-flow

Протокол старта / закрытия сессии и релиза — это slash-команды, описанные в `CLAUDE.md`:

- **`/start`** (или «начни сессию разработки») — онбординг: sync с origin, чтение источников правды, доклад состояния.
- **`/close_session`** (или «закрой сессию» / «заверши сессию») — сохранить нитку в `SESSION_HANDOFF.md` и синхронизировать **всё** на GitHub. Сессия не закрыта, пока sync-гейт не зелёный (GitHub — источник истины между машинами).
- **`/reliz`** (или «создай релиз») — выпуск по `CLAUDE.md` §Release process.

**Git — только PR-flow ([ADR-0002](../../brain_matrica/adr/0002-pr-only-flow-no-direct-push.md)):** прямой `git push origin main` запрещён; ветка → push → PR → merge. Деплой на прод и выпуск клиентского релиза — **отдельный осознанный шаг** (`/reliz` + ручной деплой), а не автоматическая часть закрытия сессии. Правила git-safety (грязное дерево, осторожность с force-push/reset/overwrite) — в `CLAUDE.md`.

## Напоминание для ИИ-агентов: прод-сервер
- **Доступ к управлению прод-VPS есть через SSH** (OpenSSH, Host-алиас из `~/.ssh/config`, в проекте обычно `matricarmz`). Выполняйте команды на сервере в терминале (`ssh matricarmz "..."` и интерактивные сессии).
- Отдельный MCP-сервер для SSH к проду **не используется** и в документации не описывается. Не предлагайте настраивать ssh-mcp / `vps-matricarmz` для этого репозитория.

## С чего знакомиться с проектом
- Краткая актуальная память проекта и важные изменения: [`PROJECT_STATE.md`](PROJECT_STATE.md)
- Общая карта проекта, запуск, ENV, логи и ключевые команды: [`OPERATIONS.md`](OPERATIONS.md)
- Локальная разработка на Windows 11 и **SSH к прод-VPS**: [`WINDOWS_DEVELOPMENT.md`](WINDOWS_DEVELOPMENT.md)
- Если есть инцидент с синком/деплоем: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
- Если задача про обновления/релизы: [`RELEASE.md`](RELEASE.md)
- Если задача про отчеты: [`REPORTS.md`](REPORTS.md)
- Если задача про ledger/sync архитектуру: [`BLOCKCHAIN.md`](BLOCKCHAIN.md)

## Профильные документы
- Безопасность и секреты: [`SECURITY.md`](SECURITY.md)
- UI-стандарты renderer: [`UI_VISUAL_STANDARDS.md`](UI_VISUAL_STANDARDS.md)
- UI-паспорта окон и модулей клиента: [`UI_PASSPORTS/README.md`](_archive/UI_PASSPORTS/README.md)
- Складской модуль: [`WAREHOUSE.md`](WAREHOUSE.md)
- Прогнозирование сборки двигателей (идея и контекст задачи): [`TASK_ENGINE_FORECAST.md`](_archive/TASK_ENGINE_FORECAST.md)
- AI/Ollama профили: [`AI_PERFORMANCE_PROFILES.md`](_archive/AI_PERFORMANCE_PROFILES.md)

## Правило поддержки актуальности docs
- Обязательная политика обновления документации при изменениях в коде: [`DOCUMENTATION_POLICY.md`](DOCUMENTATION_POLICY.md)
- Коротко: любой значимый change в архитектуре, update-flow, отчетах, ENV, скриптах или эксплуатационных шагах должен сопровождаться обновлением документации в той же сессии/PR.
- Для межсессионной памяти агента использовать краткий файл [`PROJECT_STATE.md`](PROJECT_STATE.md), а не раздувать `README.md` историческим шумом.

## Базовые инварианты системы
- Синхронизация клиента только через ledger-эндпоинты: `POST /ledger/tx/submit`, `GET /ledger/state/changes`.
- Legacy `sync/*` не используется в рабочем контуре.
- Релиз клиента для автообновлений должен быть опубликован в ledger с корректными `version`, `fileName`, `size`, `sha256`.
- Секреты (`.env`, токены, ключи) не храним в репозитории.
