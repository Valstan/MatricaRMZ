# UUID-only склад — задепрайоритизирован (low ROI) 🗓 since:2026-05-27

**Раздел:** [PENDING_FOLLOWUPS](../PENDING_FOLLOWUPS.md) → «🟡 Техдолг»

Phase 2.x (FK `warehouse_location_id`) на проде. Остаток — полный UUID-only: `WAREHOUSE_LOCATION_*`/`workshopWarehouseId` — **живая протокольная конвенция** (enum `payloadJson` `repair_fund`/`scrap`, code→uuid резолв, UI-классификация), снос = миграция протокола `payloadJson` (breaking + миграция истории). `StockBalance/StockMovement.warehouseId?` снимается только вместе. Поднимать только при осознанной протокол-миграции. Файлы: `shared/src/domain/warehouseLocations.ts`, `warehouse.ts`.
