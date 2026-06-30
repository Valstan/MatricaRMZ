# 3-Level Warehouse Audit Snapshot

This snapshot captures the pre-migration state for the safe transition to:

1. `directories`
2. `nomenclature`
3. `engine_instances`

No data-changing steps are included here.

## Current storage split

- Warehouse accounting is already in ERP tables (`erp_nomenclature`, `erp_reg_stock_balance`, `erp_reg_stock_movements`, `erp_document_headers`, `erp_document_lines`).
- Engine lifecycle (engine card, contract relation, repair statuses) is still based on `entities` + `attribute_values`.
- Part-to-engine-brand compatibility is represented as `part_engine_brand` entities/attributes.
- Sync/Ledger currently include warehouse nomenclature + stock balances/movements, but do not yet include engine instances or nomenclature↔brand matrix as dedicated sync tables.

## Critical relationship inventory

- Contract linkage for engines: `engine` entity attribute `contract_id`.
- Engine brand linkage: engine attribute `engine_brand_id` and/or `engine_brand`.
- Work orders use `engineId` in payload/domain (work order remains on operational domain, not in warehouse ERP tables).
- Warehouse stock register still allows `part_card_id` and `nomenclature_id`, so legacy part-card accounting is active in parallel.

## Read-only SQL checks (before migration)

```sql
-- 1) Size of ERP warehouse core
select
  (select count(*) from erp_nomenclature where deleted_at is null) as nomenclature_count,
  (select count(*) from erp_reg_stock_balance) as stock_balance_count,
  (select count(*) from erp_reg_stock_movements) as stock_movements_count,
  (select count(*) from erp_document_headers where deleted_at is null) as document_headers_count,
  (select count(*) from erp_document_lines where deleted_at is null) as document_lines_count;

-- 2) Engines with contract link (legacy entities model)
with engine_type as (
  select id from entity_types where code = 'engine' and deleted_at is null limit 1
),
engine_attr as (
  select ad.id, ad.code
  from attribute_defs ad
  join engine_type et on et.id = ad.entity_type_id
  where ad.deleted_at is null and ad.code in ('contract_id', 'engine_brand_id', 'engine_number')
)
select
  count(distinct e.id) as engines_total,
  count(distinct case when av_contract.value_json is not null then e.id end) as engines_with_contract
from entities e
join engine_type et on et.id = e.type_id
left join engine_attr d_contract on d_contract.code = 'contract_id'
left join attribute_values av_contract
  on av_contract.entity_id = e.id
 and av_contract.attribute_def_id = d_contract.id
 and av_contract.deleted_at is null
where e.deleted_at is null;

-- 3) Legacy part↔engine_brand compatibility rows (entities model)
with peb_type as (
  select id from entity_types where code = 'part_engine_brand' and deleted_at is null limit 1
)
select count(*) as part_engine_brand_links
from entities e
join peb_type t on t.id = e.type_id
where e.deleted_at is null;

-- 4) Existing nomenclature mirror rows for parts (spec_json contains source=part)
select count(*) as part_mirror_rows
from erp_nomenclature n
where n.deleted_at is null
  and n.spec_json is not null
  and n.spec_json like '%"source":"part"%';
```

## Migration safety constraints

- Do not remove or rewrite existing `engine` entities in phase 1.
- Do not delete `part_engine_brand` links in phase 1.
- Use additive schema changes only (new columns/tables + backfill).
- Run dry-run first and block apply on:
  - duplicate SKU candidates
  - duplicate serial numbers per `nomenclature_id`
  - FK orphan references
  - Sync/Ledger table mismatch
