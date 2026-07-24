import { createHash, randomUUID } from 'node:crypto';

import { extractBomLineNormPercent } from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import {
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  repairNormLines,
  repairNormSetBrandLinks,
  repairNormSets,
} from '../database/schema.js';
import { parseWarehouseBomLineMeta } from '../services/warehouseBomLineMeta.js';

const APPLY = process.argv.includes('--apply');

const SOURCES = [
  {
    key: 'v59-2026-07-02',
    name: 'Нормы ремонта В-59',
    bomId: 'cc156ff4-efcd-4514-a089-9620069a6da7',
    createdAt: [1782996528059],
    expectedCount: 519,
    expectedHash: '11a1bf2f7812522c6dde5e83ffaeed75',
    archiveBom: false,
  },
  {
    key: 'v84-2026-07',
    name: 'Нормы ремонта В-84',
    bomId: '51d5dc51-1da6-4745-afe7-759a09a50c3b',
    createdAt: [1782996533089, 1784288824700],
    expectedCount: 539,
    expectedHash: 'f8eace5917d36f778de805d3d528819e',
    archiveBom: false,
  },
  {
    key: 'utd20-2026-07-17',
    name: 'Нормы ремонта УТД-20',
    bomId: 'e7baaf25-5c9f-40cc-be55-8c07fd5229c1',
    createdAt: [1784288775191],
    expectedCount: 276,
    expectedHash: '1e5a41f047a3bd823258f0599974d09f',
    archiveBom: true,
  },
] as const;

type SourceLine = typeof erpEngineAssemblyBomLines.$inferSelect;

function contentHash(lines: SourceLine[]): string {
  const payload = [...lines]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((line) =>
      [
        line.id,
        line.bomId,
        line.componentNomenclatureId,
        line.componentType,
        line.qtyPerUnit,
        line.variantGroup ?? '',
        String(line.isRequired),
        line.priority,
        line.notes ?? '',
        line.createdAt,
        line.updatedAt,
      ].join('\x1f'),
    )
    .join('\x1e');
  return createHash('md5').update(payload).digest('hex');
}

function groupName(notes: string | null): string | null {
  const text = parseWarehouseBomLineMeta(notes).text?.trim() ?? '';
  const withoutNorm = text.replace(/\s*·?\s*норма расхода\s+[\d.,]+%\s*$/iu, '').trim();
  return withoutNorm || null;
}

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `select exists(select 1 from information_schema.tables where table_schema='public' and table_name=$1) as exists`,
    [name],
  );
  return Boolean(result.rows[0]?.exists);
}

async function main(): Promise<void> {
  if (!(await tableExists('repair_norm_sets'))) {
    throw new Error('Таблицы реестра норм не созданы. Сначала выполните db:migrate.');
  }

  const prepared: Array<{
    source: (typeof SOURCES)[number];
    lines: SourceLine[];
    brandIds: string[];
    existingSetId: string | null;
  }> = [];
  for (const source of SOURCES) {
    const lines = await db
      .select()
      .from(erpEngineAssemblyBomLines)
      .where(
        and(
          eq(erpEngineAssemblyBomLines.bomId, source.bomId),
          inArray(erpEngineAssemblyBomLines.createdAt, [...source.createdAt]),
        ),
      );
    const hash = contentHash(lines);
    if (lines.length !== source.expectedCount) {
      throw new Error(`${source.key}: ожидалось ${source.expectedCount} строк, найдено ${lines.length}`);
    }
    if (hash !== source.expectedHash) {
      throw new Error(`${source.key}: хеш ${hash} не совпадает с контрольным ${source.expectedHash}`);
    }
    if (lines.some((line) => !source.createdAt.includes(line.createdAt as never))) {
      throw new Error(`${source.key}: обнаружен неожиданный timestamp`);
    }
    const brandLinks = await db
      .select({ engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId })
      .from(erpEngineAssemblyBomBrandLinks)
      .where(
        and(
          eq(erpEngineAssemblyBomBrandLinks.bomId, source.bomId),
          isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
        ),
      );
    const brandIds = [...new Set(brandLinks.map((row) => String(row.engineBrandId)))];
    if (brandIds.length === 0) throw new Error(`${source.key}: BOM не привязан ни к одной марке`);
    const sourceKey = `migration:repair-norms:${source.key}`;
    const existing = await db
      .select({ id: repairNormSets.id, hash: repairNormSets.sourceContentHash })
      .from(repairNormSets)
      .where(and(eq(repairNormSets.sourceKey, sourceKey), isNull(repairNormSets.deletedAt)))
      .limit(1);
    if (existing[0] && existing[0].hash !== source.expectedHash) {
      throw new Error(`${source.key}: существующий набор норм имеет другой контрольный хеш`);
    }
    if (existing[0]) {
      const migratedLines = await db
        .select({ id: repairNormLines.id })
        .from(repairNormLines)
        .where(and(eq(repairNormLines.normSetId, existing[0].id), isNull(repairNormLines.deletedAt)));
      if (migratedLines.length !== source.expectedCount) {
        throw new Error(
          `${source.key}: в существующем наборе ожидалось ${source.expectedCount} строк, найдено ${migratedLines.length}`,
        );
      }
    }
    prepared.push({ source, lines, brandIds, existingSetId: existing[0] ? String(existing[0].id) : null });
    console.log(
      `[ok] ${source.key}: ${lines.length} строк, timestamps=${source.createdAt.join(',')}, hash=${hash}, brands=${brandIds.length}${existing[0] ? ', уже перенесено' : ''}`,
    );
  }

  const v59 = prepared.find((item) => item.source.key === 'v59-2026-07-02')!;
  const v84 = prepared.find((item) => item.source.key === 'v84-2026-07')!;
  const utd20 = prepared.find((item) => item.source.key === 'utd20-2026-07-17')!;
  if (v59.lines.length !== 519 || v84.lines.length !== 539 || utd20.lines.length !== 276) {
    throw new Error('Контрольные количества 519/539/276 не соблюдены');
  }

  if (!APPLY) {
    console.log('[dry-run] Проверки пройдены. Изменения не выполнялись.');
    return;
  }
  if (prepared.every((item) => item.existingSetId)) {
    console.log('[apply] Миграция уже применена; повторный запуск — no-op.');
    return;
  }
  if (prepared.some((item) => item.existingSetId)) {
    throw new Error('Миграция применена частично; автоматическое продолжение заблокировано');
  }

  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const item of prepared) {
      const setId = randomUUID();
      const sourceKey = `migration:repair-norms:${item.source.key}`;
      await tx.insert(repairNormSets).values({
        id: setId,
        name: item.source.name,
        version: 1,
        status: 'active',
        sourceKind: 'bom_import_cleanup',
        sourceKey,
        sourceImportedAt: Math.max(...item.source.createdAt),
        sourceContentHash: item.source.expectedHash,
        notes: `Перенесено из ошибочно использованной BOM ${item.source.bomId}; исходные строки идентифицированы по timestamp и хешу.`,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      await tx.insert(repairNormSetBrandLinks).values(
        item.brandIds.map((engineBrandId) => ({
          id: randomUUID(),
          normSetId: setId,
          engineBrandId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })),
      );
      await tx.insert(repairNormLines).values(
        item.lines.map((line, position) => ({
          id: randomUUID(),
          normSetId: setId,
          nomenclatureId: line.componentNomenclatureId,
          qtyPerEngine: String(line.qtyPerUnit),
          replacementPercent: String(extractBomLineNormPercent(line.notes) ?? 100),
          groupName: groupName(line.notes),
          sourceRowKey: String(line.id),
          sourceMetaJson: JSON.stringify({
            originalBomId: String(line.bomId),
            originalBomLineId: String(line.id),
            originalCreatedAt: Number(line.createdAt),
            originalUpdatedAt: Number(line.updatedAt),
          }),
          position,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        })),
      );
      await tx
        .update(erpEngineAssemblyBomLines)
        .set({ deletedAt: now })
        .where(inArray(erpEngineAssemblyBomLines.id, item.lines.map((line) => line.id) as any));
      if (item.source.archiveBom) {
        await tx
          .update(erpEngineAssemblyBomBrandLinks)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(erpEngineAssemblyBomBrandLinks.bomId, item.source.bomId), isNull(erpEngineAssemblyBomBrandLinks.deletedAt)));
        await tx
          .update(erpEngineAssemblyBom)
          .set({ status: 'archived', deletedAt: now, updatedAt: now })
          .where(eq(erpEngineAssemblyBom.id, item.source.bomId));
      }
    }
  });
  console.log('[apply] Нормы перенесены; ошибочные строки BOM и BOM УТД-20 архивированы.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
