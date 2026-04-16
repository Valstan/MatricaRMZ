import 'dotenv/config';

import { pool } from '../database/db.js';

function hasFlag(name: string) {
  return process.argv.includes(name);
}

async function scalarNumber(sqlText: string, params: unknown[] = []): Promise<number> {
  const res = await pool.query(sqlText, params);
  return Number(res.rows[0]?.count ?? 0);
}

async function main() {
  const asJson = hasFlag('--json');

  const sourceCounts = {
    entities_engine_brand: await scalarNumber(
      `select count(*)::int as count
       from entities e
       join entity_types t on t.id = e.type_id and t.deleted_at is null
       where t.code = 'engine_brand' and e.deleted_at is null`,
    ),
    entities_part: await scalarNumber(
      `select count(*)::int as count
       from entities e
       join entity_types t on t.id = e.type_id and t.deleted_at is null
       where t.code = 'part' and e.deleted_at is null`,
    ),
    entities_tool: await scalarNumber(
      `select count(*)::int as count
       from entities e
       join entity_types t on t.id = e.type_id and t.deleted_at is null
       where t.code = 'tool' and e.deleted_at is null`,
    ),
    entities_product: await scalarNumber(
      `select count(*)::int as count
       from entities e
       join entity_types t on t.id = e.type_id and t.deleted_at is null
       where t.code = 'product' and e.deleted_at is null`,
    ),
    entities_service: await scalarNumber(
      `select count(*)::int as count
       from entities e
       join entity_types t on t.id = e.type_id and t.deleted_at is null
       where t.code = 'service' and e.deleted_at is null`,
    ),
  };

  const targetCounts = {
    directory_engine_brands: await scalarNumber(`select count(*)::int as count from directory_engine_brands where deleted_at is null`),
    directory_parts: await scalarNumber(`select count(*)::int as count from directory_parts where deleted_at is null`),
    directory_tools: await scalarNumber(`select count(*)::int as count from directory_tools where deleted_at is null`),
    directory_goods: await scalarNumber(`select count(*)::int as count from directory_goods where deleted_at is null`),
    directory_services: await scalarNumber(`select count(*)::int as count from directory_services where deleted_at is null`),
    erp_nomenclature: await scalarNumber(`select count(*)::int as count from erp_nomenclature where deleted_at is null`),
  };

  const mirrorRows = await scalarNumber(
    `select count(*)::int as count
     from erp_nomenclature
     where deleted_at is null and coalesce(spec_json, '') like '%"source":"part"%'`,
  );

  const fkOrphans = {
    stock_balance_nomenclature: await scalarNumber(
      `select count(*)::int as count
       from erp_reg_stock_balance b
       left join erp_nomenclature n on n.id = b.nomenclature_id and n.deleted_at is null
       where b.nomenclature_id is not null and n.id is null`,
    ),
    stock_movement_nomenclature: await scalarNumber(
      `select count(*)::int as count
       from erp_reg_stock_movements m
       left join erp_nomenclature n on n.id = m.nomenclature_id and n.deleted_at is null
       where n.id is null`,
    ),
    engine_instances_nomenclature: await scalarNumber(
      `select count(*)::int as count
       from erp_engine_instances i
       left join erp_nomenclature n on n.id = i.nomenclature_id and n.deleted_at is null
       where i.deleted_at is null and n.id is null`,
    ),
    document_lines_part_card: await scalarNumber(
      `select count(*)::int as count
       from erp_document_lines l
       left join erp_part_cards p on p.id = l.part_card_id and p.deleted_at is null
       where l.deleted_at is null and l.part_card_id is not null and p.id is null`,
    ),
    nomenclature_directory_ref_missing: await scalarNumber(
      `select count(*)::int as count
       from erp_nomenclature n
       left join directory_engine_brands deb
         on n.directory_kind = 'engine_brand' and deb.id = n.directory_ref_id and deb.deleted_at is null
       left join directory_parts dp
         on n.directory_kind = 'part' and dp.id = n.directory_ref_id and dp.deleted_at is null
       left join directory_tools dt
         on n.directory_kind = 'tool' and dt.id = n.directory_ref_id and dt.deleted_at is null
       left join directory_goods dg
         on n.directory_kind = 'good' and dg.id = n.directory_ref_id and dg.deleted_at is null
       left join directory_services ds
         on n.directory_kind = 'service' and ds.id = n.directory_ref_id and ds.deleted_at is null
       where n.deleted_at is null
         and n.directory_ref_id is not null
         and (
           (n.directory_kind = 'engine_brand' and deb.id is null) or
           (n.directory_kind = 'part' and dp.id is null) or
           (n.directory_kind = 'tool' and dt.id is null) or
           (n.directory_kind = 'good' and dg.id is null) or
           (n.directory_kind = 'service' and ds.id is null)
         )`,
    ),
  };

  const collisionChecks = {
    active_sku_duplicates: await scalarNumber(
      `select count(*)::int as count
       from (
         select sku
         from erp_nomenclature
         where deleted_at is null and sku is not null and trim(sku) <> ''
         group by sku
         having count(*) > 1
       ) d`,
    ),
    active_code_duplicates: await scalarNumber(
      `select count(*)::int as count
       from (
         select code
         from erp_nomenclature
         where deleted_at is null
         group by code
         having count(*) > 1
       ) d`,
    ),
  };

  const report = {
    mode: 'dry-run',
    generatedAt: new Date().toISOString(),
    sourceCounts,
    targetCounts,
    mirrorRows,
    fkOrphans,
    collisionChecks,
    canApply: Object.values(fkOrphans).every((n) => n === 0) && Object.values(collisionChecks).every((n) => n === 0),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('[directories->nomenclature] dry-run');
    console.log(report);
  }
}

main()
  .catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
