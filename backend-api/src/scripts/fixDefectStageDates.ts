import 'dotenv/config';

import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { operations, attributeValues, attributeDefs } from '../database/schema.js';

async function main(): Promise<void> {
  console.log('Fixing disassembly_defect stage dates...');

  // 1. Get all disassembly_defect stages (stored as repair_history_entry with meta containing stage.code)
  // Using raw SQL because Drizzle's like() doesn't work as expected with % patterns
  process.stdout.write('Executing raw SQL query...\n');
  let stagesResult: any;
  try {
    stagesResult = await pool.query(`
      select id, engine_entity_id, operation_type, meta_json, performed_at, created_at
      from operations
      where operation_type = 'repair_history_entry'
        and deleted_at is null
        and meta_json like '%disassembly_defect%'
      order by created_at desc
    `);
    process.stdout.write(`Query executed successfully, rowCount: ${stagesResult.rowCount}, rows: ${stagesResult.rows?.length ?? 0}\n`);
  } catch (e) {
    process.stderr.write(`Query failed: ${String(e)}\n`);
    throw e;
  }
  const stages = stagesResult.rows as any[];
  process.stdout.write(`Found ${stages.length} disassembly_defect stages\n`);
  if (stages.length > 0) {
    process.stdout.write(`First stage: id=${stages[0].id}, engineId=${stages[0].engine_entity_id}, performedAt=${stages[0].performed_at}, meta=${String(stages[0].meta_json).slice(0, 200)}\n`);
  }

  if (stages.length === 0) {
    console.log('No stages to fix');
    return;
  }

  // 2. Get all defect_date attributes for engines that have these stages
  const engineIds = [...new Set(stages.map((s) => s.engineEntityId))];
  const defectDateDef = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(eq(attributeDefs.code, 'defect_date'))
    .limit(1);

  if (defectDateDef.length === 0) {
    console.log('defect_date attribute definition not found');
    return;
  }
  const defectDateDefId = defectDateDef[0]!.id;

  const attrRows = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(and(eq(attributeValues.attributeDefId, defectDateDefId), inArray(attributeValues.entityId, engineIds as any), isNull(attributeValues.deletedAt)));

  const defectDateByEngine = new Map<string, number>();
  for (const row of attrRows) {
    try {
      const val = JSON.parse(String(row.valueJson));
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        defectDateByEngine.set(String(row.entityId), val);
      }
    } catch {
      // ignore parse errors
    }
  }

  console.log(`Found defect_date for ${defectDateByEngine.size} engines`);

  let fixed = 0;
  let skipped = 0;
  let missing = 0;

  for (const stage of stages) {
    const engineId = stage.engineEntityId;
    const defectDate = defectDateByEngine.get(engineId);

    if (!defectDate) {
      missing++;
      continue;
    }

    const currentAt = Number(stage.performedAt ?? stage.createdAt ?? 0);
    if (currentAt === defectDate) {
      skipped++;
      continue;
    }

    // Update the stage
    await db
      .update(operations)
      .set({ performedAt: defectDate, updatedAt: Date.now() })
      .where(eq(operations.id, stage.id));

    fixed++;
    console.log(`Fixed stage ${stage.id} for engine ${engineId}: ${currentAt} -> ${defectDate}`);
  }

  console.log(`Fixed: ${fixed}, Skipped (already correct): ${skipped}, Missing defect_date: ${missing}`);
}

main()
  .catch((e) => {
    console.error(String((e as Error)?.message ?? e));
    process.exitCode = 2;
  })
  .finally(() => void pool.end().catch(() => {}));