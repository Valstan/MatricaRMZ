# Session Handoff

> Sticky-note для непрерывности разработки между сессиями и компьютерами. Перезаписывается целиком командой `/close_session`. История — через `git log -- docs/SESSION_HANDOFF.md`.

**Status:** ACTIVE
**Updated:** 2026-08-18 (Claude session, машина `PC40`)
**Branch:** `main` = `origin/main`, дерево чистое (в обоих репо).
**Last released version:** v3.2.0 на проде (эта сессия релизов не выпускала).

## Текущая нитка

**Матрица 4 стартовала + финиш EAV→erp_* в v3** — план [`docs/plans/matrica-v4-kickoff-2026-08.md`](plans/matrica-v4-kickoff-2026-08.md) (директива D-031, решения владельца 18.08: репо **Matrica4**, пилот Ф1 — **отчёты**). Трек A (Ф0) выполнен за сессию: репо [Valstan/Matrica4](https://github.com/Valstan/Matrica4) создан, скелет ядра (контракт + kernel с safe mode + гейты границ + модуль-образец, 31 тест) влит и прошёл адверсариальное ревью (15 находок закрыты в Matrica4#1). Трек B (лечение базы) — план записан, исполнение не начато.

## Следующий шаг

**Трек B, этап 0 — гигиена (S), в этом репо:**
1. Снести мёртвый `/erp`-прототип: `backend-api/src/routes/erp.ts` (живой `getContractSections` из `erpService.ts:568` перенести к вызывателю `routes/warehouse.ts:66`), пустые таблицы прототипа (`erp_part_templates`, `erp_tool_templates/cards`, `erp_reg_contract_settlement`, `erp_reg_employee_access`) дроп-миграцией, скрипты `erpLegacyCleanup.ts` (⚠️ опасен — снёс бы живые EAV-договоры/сотрудников), `migrateEavToErp.ts`, `dryRunDirectoriesToNomenclature.ts`.
2. Разобрать пути «читаем пустоту»: `warehouseService.ts:899-902` (дропдауны из пустых `erp_counterparties`/`erp_contracts`/`erp_employee_cards`), AI `getContracts` в `llmTools.ts`.
3. Починить дрейф карт синка: `routes/ledger.ts` `PG_SYNC_TABLES` не содержит `ErpEngineInstances`, `pullChangesSince.ts:77-79` содержит.
4. Дальше по плану: этап 1 — марки двигателей (переворот источника правды, FK-блокер синка).

Трек A следующий шаг (отдельной сессией, в Matrica4): Ф1 — модуль отчётов; сначала спроектировать механизм «ядро загружает entry вклада и отдаёт реестр» (зафиксировано в контракте как proposed на Ф1).

## Контекст

- **План:** `docs/plans/matrica-v4-kickoff-2026-08.md` (оба трека, этапы B0–B6, замеры прода).
- **Замеры прода 18.08:** живых `attribute_values` 43 722 (engine 28 396, employee 5 615, part_engine_brand 2 821, service 2 536, contract 975); `erp_contracts`/`erp_counterparties`/`erp_employee_cards`/`erp_engine_instances`/`repair_norm_sets` — **все 0 строк** (точный count(*); прогон норм из PR #320 на проде никогда не выполнялся).
- **Коммиты v3:** #614 (план+гейт поколений+EAV-freeze+ack брейну), #615 (грабли PC40). **Matrica4:** `0e106d5` скелет Ф0, `b16eaee` фиксы ревью (#1); CI (ci+gitleaks) зелёный.
- **EAV-freeze действует** (AGENTS.md §EAV): новые фичи не добавляют EAV-атрибутов.
- **Гейт поколений** в AGENTS.md обоих репо; в Matrica4 нет релизных механизмов клиентов (предохранители владельца).
- Письма брейну: `mailbox/to-brain/2026-08-18-d031-kickoff-ack-and-eav-assessment.md` (+ идея про слепоту границ-линтеров в этом handoff-PR).
- Прод: не трогался, кроме read-only SQL-замеров. Открытых PR нет, лишних веток нет.

## Что не сработало

- **12 из 15 верификаторов адверсариального ревью упали в session-limit** — доверификация сделана вручную по коду (все находки оказались реальными и закрыты). Урок: verify-стадию воркфлоу на длинной сессии дозировать.
- **`gh repo create --push` не докинул первый пуш** — main нового репо защищён глобальным pre-push хуком PC40 + deny-правилами Claude-сессии; рабочий путь бутстрапа записан в `docs/machines/PC40.md` (разово по явному ок владельца).

## Открытые вопросы для пользователя

- Прежние, живут в `PENDING_FOLLOWUPS`: три договора «20/ГОЗ-25»; ключ PC40 от 22.05 снять после **24.08** (уже скоро); окно на 12 обнулённых конфигов прода.
- Новый: чистка ~200 мусорных типов `t_bulk_*` (по 1 сущности) — прод-данные, нужно ок (можно взять в этап B0).

## Не забыть (low-priority)

- Ledger-токен ≤04.09 🔴 (календарь в PENDING).
- Механизм исполнения ReportContribution — спроектировать ДО начала Ф1 (docstring в контракте это фиксирует).
- brain проверит артефакт сканера секретов 24.08 (письмо от 17.08) — у нас уже зелёный, ничего делать не надо.
