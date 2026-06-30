# План: Дефектовка → авто-список запчастей (заявка в снабжение)

> Источник: brain-бэклог `2026-06-04-feature-backlog-traceability-costing-qr.md` идея #2 (compliance=suggest, владелец одобрил направление). Продуктовое решение 2026-06-08: авто-список идёт в **черновик SupplyRequest** (заявка в снабжение). Подход — probe-before-build: медиа-фундамент проверен и готов, строим доменную логику.

## Context (что уже есть — разведка 2026-06-08)

- **Медиа-хранилище готово и работает на проде:** `file_assets` (`storageKind: local|yandex`), ≤10 МБ локально / >10 МБ прямой PUT в Яндекс по pre-signed URL, sha256-дедуп, превью, soft-delete с change-request. Прод: Яндекс настроен (`/matricarmz/files`, токен есть), 56 файлов/794 МБ на Яндексе + 216/424 МБ локально. `FileRef` хранится в EAV/`operations.metaJson`. `AttachmentsPanel` переиспользуется везде, включая дефектовку.
- **«Проблема с медиа» из бэклога — фактически снята.** Реальный остаточный зазор: загрузка **онлайн-только** (`filesUpload` синхронно дёргает бэкенд/Яндекс, offline-очереди нет). На практике не блокер (заводские ПК в LAN, периодически онлайн). Offline-queue — отдельное опциональное упрочнение, НЕ в scope MVP.
- **Дефектовка** (`shared/src/domain/repairChecklist.ts`): `EngineInventoryRow` с `repairable_qty`/`scrap_qty`/`replace_qty` (сумма = `quantity`). **`replace_qty > 0` = «заказать новую» = кандидат в заявку.** Идентификация: `part_name` (ключ), `part_number`, `assembly_unit_number`, `quantity`, `bom_variant_group`. Строки в `answers.engine_inventory_items` → `operations.metaJson`. Панель — `RepairChecklistPanel` в [`EngineDetailsPage.tsx:1011`](../../electron-app/src/renderer/src/ui/pages/EngineDetailsPage.tsx), stage `engine_inventory`, edit под `canEditOperations`.
- **SupplyRequest** (`shared/src/domain/supplyRequest.ts`): `SupplyRequestItem = {lineNo?, productId?, name, qty, unit?, note?}`; `createSupplyRequest(db, actor, scope)` → черновик (`status:'draft'`, `items:[]`, `departmentId` из профиля); `updateSupplyRequest({id, payload})` пишет items. IPC `supplyRequests:create` / `supplyRequests:update`. Хранится в `operations` (контейнер `SupplyRequestsContainerEntityId`).

## Этапы

### MVP-1 — кнопка «Заявка в снабжение из негодных» ✅ СМЕРЖЕН 2026-06-08 (PR #283, `870961a9`, client+shared, не релизился)

**Сделано как описано ниже.** Статические гейты зелёные (typecheck/lint/5 unit `defectToSupplyRequest.test.ts`/243 backend/CI). **CDP-verify НЕ прогнан — заблокирован verifier rot:** dev `verify`-юзер (admin) ловит в electron-main «permission denied: engines.view» на карточке двигателя (единственная поверхность фичи) → bridge зависает; плюс dev-electron нестабилен. Backend даёт admin все права (на проде двигатели открываются) — это рассинхрон локальных прав dev-клиента, не дефект. **Follow-up:** починить верификатор (engines.view-синк + стабильность) и прогнать CDP-smoke `.verifier-electron/cdp-defect-supply.mjs` (драйвер написан, готов). См. `PENDING_FOLLOWUPS.md`.


- **Shared (pure + tested):** `buildSupplyRequestItemsFromInventory(rows)` в `shared/src/domain/repairChecklist.ts` (или соседний модуль) — берёт строки `replace_qty > 0` → `SupplyRequestItem[]` (`name=part_name`, `qty=replace_qty`, `note` из `part_number`/`assembly_unit_number`, `productId` если в строке есть resolved part id, `unit` если доступен). Дедуп/агрегация по детали. Юнит-тесты (пустой, фильтр по replace_qty, маппинг, агрегация).
- **UI:** в `RepairChecklistPanel` при `stage==='engine_inventory'` + новый опц. проп-колбэк `onCreateSupplyRequestFromDefects?(items)` — кнопка «Заявка в снабжение из негодных (N)», активна при N>0 и наличии колбэка. Панель только извлекает items и зовёт колбэк (не coupling с supply-доменом).
- **Parent (`EngineDetailsPage`):** реализует колбэк — `supplyRequests.create()` → merge items в payload → `supplyRequests.update()` → навигация на карточку заявки (или тост + ссылка). Гейт прав: создание заявок (как на `SupplyRequestsPage`).
- **Гейты:** build shared → typecheck → lint → backend test → CDP /verify (UI): отметить replace_qty на строке дефектовки → кнопка активна → клик → создаётся черновик заявки с правильными items.

### MVP-2 (опц., по выбору владельца) — фото на уровне строки детали
- Привязка `FileRef[]` к конкретной `EngineInventoryRow` (сейчас вложения на уровне листа). Хранить в строке (`row.photos: FileRef[]`), мини-превью в строке, переиспользовать `AttachmentsPanel`/`useFileUploadFlow`. Фото попадает в note/audit заявки как доказательство дефекта.

### MVP-3 (опц.) — offline-очередь загрузки медиа
- Персистентная очередь в SQLite: при offline стейджить байты локально, грузить при восстановлении связи, реконсилить `FileRef` в операцию. Только если дефектовка-offline окажется реальным сценарием.

## Гейты / переносимость
- Гейты #027 (build → typecheck/lint → test → CDP-verify при UI) перед мержем.
- `buildSupplyRequestItemsFromInventory` — pure, тестируемая; «извлечь список из табличных строк по предикату» — потенциально переносимый паттерн (как analytics-ядро).
