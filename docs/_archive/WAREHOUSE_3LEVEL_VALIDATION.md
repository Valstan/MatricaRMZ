# 3-Level Warehouse Validation Gates

This checklist is used before and after `APPLY MIGRATION`.

## 1) Dry-run (required before apply)

Run from repository root:

```powershell
corepack pnpm --filter @matricarmz/backend-api exec tsx src/scripts/warehouseThreeLevelDryRun.ts --json
```

Expected:

- `mode = "dry-run"`
- `canApply = true`
- `skuConflicts = 0`
- `serialConflicts = 0`

## 2) Apply migration (only after approval)

```powershell
corepack pnpm --filter @matricarmz/backend-api exec tsx src/scripts/warehouseThreeLevelDryRun.ts --apply --json
```

## 3) FK and uniqueness checks

```sql
-- Nomenclature SKU uniqueness (active rows)
select sku, count(*) from erp_nomenclature where deleted_at is null and sku is not null group by sku having count(*) > 1;

-- Instance uniqueness by nomenclature + serial
select nomenclature_id, serial_number, count(*)
from erp_engine_instances
where deleted_at is null
group by nomenclature_id, serial_number
having count(*) > 1;

-- Compatibility FK orphans
select neb.id
from erp_nomenclature_engine_brand neb
left join erp_nomenclature n on n.id = neb.nomenclature_id
left join entities b on b.id = neb.engine_brand_id
where neb.deleted_at is null and (n.id is null or b.id is null);
```

## 4) Sync/Ledger contract checks

```powershell
corepack pnpm --filter @matricarmz/backend-api exec tsx src/scripts/checkSyncContract.ts
```

Expected output contains: `проверка синхронизации контрактов выполнена`.

## 5) Build/type checks

```powershell
corepack pnpm --filter @matricarmz/shared build
corepack pnpm --filter @matricarmz/backend-api build
corepack pnpm --filter @matricarmz/electron-app typecheck
```

All commands must exit with code 0.

## 6) Functional smoke checks

- `Номенклатура` list shows `SKU`, `category`, `default brand`, `serial tracking`.
- `Карточка номенклатуры` allows setting engine brand and serial-tracking flag.
- Engine instance creation from nomenclature card works (`serial + contract + warehouse`).
- Stock balances support filtering by `type` and `category`.
