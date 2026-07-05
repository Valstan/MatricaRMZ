# Ремфонд-осведомлённый прогноз + заявка из дефицитов + напоминание о дефектовке — 2026-07

**Задание владельца (2026-07-05, голосом):** всеобщий анализ цепочки «наряды → склад → ремфонд → дефектовка → прогноз» показал: скелет учёта работает и трассируется (аудит 3 агентами, session 2026-07-05), но прогноз слеп к ремфонду как резерву и не помогает снабжению. Владелец: «бери в работу всё».

## Контекст (из аудита)

- Прогноз (`warehouseForecastService.ts` + `shared/assemblyForecast.ts`) исключает техлокации (ремфонд/утиль/в сборке) из годного — правильно; приход ремонта учитывает только по нарядам «Выдан в работу» (`buildRepairIncomingFromWorkOrderPayloads`).
- Дефициты: `computeDeficitRecommendations` (`assemblyForecast.ts:1136`) → подсказки в `formatAssemblyDeficitHintsForPriorityBrands` (`electron-app/src/main/services/reportPresetService.ts:3664`).
- Ремфонд = системная локация `repair_fund`, остатки в `erp_reg_stock_balance`; занос из дефектовки — явная кнопка (Ф1 эпика, идемпотентно по high-water-mark `repair_fund_intake`).
- Заявки в снабжение: `SupplyRequestsPage.onOpen(id, { initialPayload })` — карточка умеет открываться с предзаполнением.

## Фазы

- **Ф1. Ремфонд-осведомлённый прогноз.** В дефицитах — второй ярус: `repairFundQty` по номенклатуре (остаток локации `repair_fund`), `coverableByRepairFund = min(deficit, repairFundQty)`, `toPurchase = deficit − coverable`. Текст подсказки: «дефицит N; ремфонд может закрыть M (в фонде K шт) → выдать ремнаряд; закупить N−M». Юнит-тесты на compute.
- **Ф2. Заявка в снабжение из дефицитов.** Кнопка на превью прогноза: собрать позиции `toPurchase > 0` → открыть карточку новой заявки с предзаполненными строками (naименование+артикул+кол-во, основание «Дефицит прогноза сборки от <дата>»).
- **Ф3. Напоминание о незанесённой дефектовке.** На карточке двигателя: если по строкам дефектовки есть годные к ремонту (`buildRepairFundIntakeFromInventory` непуст), а прошлый занос (`repair_fund_intake`) не покрывает текущий набор — бейдж «⚠ дефектовка не занесена в ремфонд» рядом с кнопкой заноса.

## Статус

- [x] Ф1 — `repairFundByNomenclatureId` в compute + `repairFundQty/coverableByRepairFund/toPurchase` в `AssemblyDeficitRecommendation`; текст подсказки с действием («выдать ремнаряд» / «закупить»); 2 юнит-теста. CDP: deficit = ремонт + закупка на 27 живых дефицитах снапшота.
- [x] Ф2 — `assemblyDeficits` в `ReportPresetPreviewResult`; кнопка «Создать заявку в снабжение (N позиц.)» на прогнозе → deferred-create заявка с предзаполненными позициями (`productId`=nomenclatureId, qty=toPurchase, note с раскладкой). CDP: карточка открывается предзаполненной.
- [x] Ф3 — `previewRepairFundIntakeFromEngine` (read-only, HWM-сравнение) + route `/repair-fund/intake-preview` (ErpDocumentsView) + IPC `warehouse:repairFund:intakePreview` + бейдж «⚠ Не занесено в ремфонд: X шт.» у кнопки заноса. CDP: preview e2e ok.

CDP-смоук `_smoke-remfond-forecast.mjs` — 7/7 PASS (2026-07-05).
