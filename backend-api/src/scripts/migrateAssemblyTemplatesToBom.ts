import { randomUUID } from 'node:crypto';

import {
  resolveNomenclatureComponentTypeId,
  type AssemblyExecutionProfile,
  type WorkOrderTemplateLine,
  type WorkOrderTemplatePayloadOverrides,
} from '@matricarmz/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import {
  attributeDefs,
  attributeValues,
  directoryServices,
  entities,
  entityTypes,
  erpEngineAssemblyBom,
  erpEngineAssemblyBomBrandLinks,
  erpEngineAssemblyBomLines,
  erpNomenclature,
  workOrderTemplates,
} from '../database/schema.js';

const APPLY = process.argv.includes('--apply');
const RETIRED_UTD_NORMS_BOM_ID = 'e7baaf25-5c9f-40cc-be55-8c07fd5229c1';

const FIXED_BOMS: Record<string, string> = {
  'Сборка 46': '2aac8855-7e04-4e1d-9c77-4fbad232e6fa',
  'Сборка 59': 'cc156ff4-efcd-4514-a089-9620069a6da7',
  'Сборка 84': '51d5dc51-1da6-4745-afe7-759a09a50c3b',
};

const BRAND_MATCHES: Record<string, string[]> = {
  'Сборка 400': ['1Д-12 400'],
  'Сборка 9Р4-6У2': ['9Р4-6У2'],
  'Сборка ЯМЗ-238Н': ['ЯМЗ-238 Н'],
  'УТД': ['УТД-20', 'УТД-20(С1)'],
};

function parseObject(value: string): WorkOrderTemplatePayloadOverrides {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as WorkOrderTemplatePayloadOverrides)
    : {};
}

function parseLines(value: string): WorkOrderTemplateLine[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? (parsed as WorkOrderTemplateLine[]) : [];
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function normalizeName(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/giu, ' ').trim();
}

async function loadBrandIdsByNames(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await db
    .select({ id: entities.id, valueJson: attributeValues.valueJson })
    .from(entities)
    .innerJoin(entityTypes, and(eq(entityTypes.id, entities.typeId), eq(entityTypes.code, 'engine_brand')))
    .innerJoin(attributeDefs, and(eq(attributeDefs.entityTypeId, entityTypes.id), eq(attributeDefs.code, 'name')))
    .innerJoin(
      attributeValues,
      and(eq(attributeValues.entityId, entities.id), eq(attributeValues.attributeDefId, attributeDefs.id), isNull(attributeValues.deletedAt)),
    )
    .where(and(isNull(entities.deletedAt), isNull(entityTypes.deletedAt)));
  const wanted = new Set(names.map(normalizeName));
  const matched = rows.filter((row) => {
    try {
      return wanted.has(normalizeName(String(JSON.parse(String(row.valueJson)))));
    } catch {
      return false;
    }
  });
  if (matched.length !== wanted.size) {
    throw new Error(`Не найдены все марки для ${names.join(', ')}: найдено ${matched.length} из ${wanted.size}`);
  }
  return matched.map((row) => String(row.id));
}

async function loadLinkedBrandIds(bomId: string): Promise<string[]> {
  const rows = await db
    .select({ engineBrandId: erpEngineAssemblyBomBrandLinks.engineBrandId })
    .from(erpEngineAssemblyBomBrandLinks)
    .where(and(eq(erpEngineAssemblyBomBrandLinks.bomId, bomId), isNull(erpEngineAssemblyBomBrandLinks.deletedAt)));
  return [...new Set(rows.map((row) => String(row.engineBrandId)))];
}

async function findActiveBomForBrands(brandIds: string[]): Promise<string | null> {
  if (brandIds.length === 0) return null;
  const rows = await db
    .select({ id: erpEngineAssemblyBom.id })
    .from(erpEngineAssemblyBom)
    .innerJoin(erpEngineAssemblyBomBrandLinks, eq(erpEngineAssemblyBomBrandLinks.bomId, erpEngineAssemblyBom.id))
    .where(
      and(
        inArray(erpEngineAssemblyBomBrandLinks.engineBrandId, brandIds as any),
        isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
        isNull(erpEngineAssemblyBom.deletedAt),
        eq(erpEngineAssemblyBom.status, 'active'),
      ),
    );
  const ids = [...new Set(rows.map((row) => String(row.id)).filter((id) => id !== RETIRED_UTD_NORMS_BOM_ID))];
  return ids.length === 1 ? ids[0]! : null;
}

async function main(): Promise<void> {
  const templates = await db
    .select()
    .from(workOrderTemplates)
    .where(and(eq(workOrderTemplates.workOrderKind, 'assembly'), isNull(workOrderTemplates.archivedAt)));
  if (templates.length === 0) {
    console.log('[ok] Активных сборочных шаблонов нет; миграция уже применена.');
    return;
  }

  const serviceIds = [...new Set(templates.flatMap((template) => parseLines(template.linesJson).map((line) => line.serviceId).filter((id): id is string => Boolean(id))))];
  const services = serviceIds.length
    ? await db
        .select({ id: directoryServices.id, name: directoryServices.name })
        .from(directoryServices)
        .where(and(inArray(directoryServices.id, serviceIds as any), isNull(directoryServices.deletedAt)))
    : [];
  const serviceNames = new Map(services.map((service) => [String(service.id), String(service.name)]));

  const prepared: Array<{
    template: (typeof templates)[number];
    lines: WorkOrderTemplateLine[];
    brandIds: string[];
    bomId: string | null;
  }> = [];
  for (const template of templates) {
    const name = String(template.name);
    const lines = parseLines(template.linesJson);
    if (lines.length === 0 || lines.some((line) => !line.nomenclatureId || !line.serviceId)) {
      throw new Error(`${name}: каждая строка сборочного шаблона должна содержать номенклатуру и услугу`);
    }
    const fixedBomId = FIXED_BOMS[name] ?? null;
    const brandIds = fixedBomId
      ? await loadLinkedBrandIds(fixedBomId)
      : await loadBrandIdsByNames(BRAND_MATCHES[name] ?? []);
    if (brandIds.length === 0) throw new Error(`${name}: не удалось определить марки двигателей`);
    const bomId = fixedBomId ?? (await findActiveBomForBrands(brandIds));
    prepared.push({ template, lines, brandIds, bomId });
    console.log(`[ok] ${name}: строк=${lines.length}, марок=${brandIds.length}, BOM=${bomId ?? 'будет создана'}`);
  }

  if (!APPLY) {
    console.log(`[dry-run] Подготовлено шаблонов: ${prepared.length}. Изменения не выполнялись.`);
    return;
  }
  const retiredUtd = await db
    .select({ deletedAt: erpEngineAssemblyBom.deletedAt })
    .from(erpEngineAssemblyBom)
    .where(eq(erpEngineAssemblyBom.id, RETIRED_UTD_NORMS_BOM_ID))
    .limit(1);
  if (retiredUtd[0] && retiredUtd[0].deletedAt == null) {
    throw new Error('Сначала примените warehouse:migrate-bom-norms: ошибочная BOM УТД-20 ещё активна');
  }

  const now = Date.now();
  await db.transaction(async (tx) => {
    for (const item of prepared) {
      const templateId = String(item.template.id);
      const templateName = String(item.template.name);
      const variantKey = `assembly-template:${templateId}`;
      let bomId = item.bomId;
      if (!bomId) {
        bomId = randomUUID();
        await tx.insert(erpEngineAssemblyBom).values({
          id: bomId,
          name: `BOM ${templateName.replace(/^Сборка\s+/iu, '')}`,
          engineNomenclatureId: null,
          version: 1,
          status: 'active',
          isDefault: true,
          defaultVariantKey: null,
          executionProfileJson: null,
          notes: `Создано из сборочного шаблона «${templateName}»`,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          syncStatus: 'synced',
          lastServerSeq: null,
        });
        await tx.insert(erpEngineAssemblyBomBrandLinks).values(
          item.brandIds.map((engineBrandId, index) => ({
            id: randomUUID(),
            bomId: bomId!,
            engineBrandId,
            isPrimary: index === 0,
            isDefaultForBrand: false,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            syncStatus: 'synced',
            lastServerSeq: null,
          })),
        );
      }

      const nomenclatureIds = item.lines.map((line) => String(line.nomenclatureId));
      const nomenclatureRows = await tx
        .select()
        .from(erpNomenclature)
        .where(and(inArray(erpNomenclature.id, nomenclatureIds as any), isNull(erpNomenclature.deletedAt)));
      const nomenclatureById = new Map(nomenclatureRows.map((row) => [String(row.id), row]));
      if (nomenclatureById.size !== new Set(nomenclatureIds).size) throw new Error(`${templateName}: номенклатура шаблона неполна`);

      await tx.insert(erpEngineAssemblyBomLines).values(
        item.lines.map((line, index) => {
          const nomenclature = nomenclatureById.get(String(line.nomenclatureId))!;
          return {
            id: randomUUID(),
            bomId: bomId!,
            componentNomenclatureId: String(line.nomenclatureId),
            componentType: resolveNomenclatureComponentTypeId(nomenclature) ?? 'other',
            qtyPerUnit: Math.max(1, Math.trunc(Number(line.defaultQty ?? 1))),
            variantGroup: variantKey,
            isRequired: true,
            priority: index,
            notes: null,
            positionKey: `template-line-${index + 1}`,
            positionLabel: String(nomenclature.name),
            isDefaultOption: true,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            syncStatus: 'synced',
            lastServerSeq: null,
          };
        }),
      );

      const overrides = parseObject(item.template.payloadOverridesJson);
      const profile: AssemblyExecutionProfile = {
        version: 1,
        hiddenFields: parseStringArray(item.template.hiddenFieldsJson),
        works: item.lines.map((line) => ({
          serviceId: String(line.serviceId),
          serviceName: line.serviceName?.trim() || serviceNames.get(String(line.serviceId)) || '',
          unit: line.unit?.trim() || 'шт',
          qty: Math.max(1, Number(line.defaultQty ?? 1)),
          priceRub: 0,
        })),
        sourceTemplateId: templateId,
        sourceTemplateName: templateName,
        ...(typeof overrides.workshopId === 'string' && overrides.workshopId.trim() ? { workshopId: overrides.workshopId.trim() } : {}),
        ...(Array.isArray(overrides.signatureBlocks)
          ? { signatureBlocks: overrides.signatureBlocks as NonNullable<AssemblyExecutionProfile['signatureBlocks']> }
          : {}),
        ...(overrides.printSettings && typeof overrides.printSettings === 'object' && !Array.isArray(overrides.printSettings)
          ? { printSettings: overrides.printSettings as Record<string, unknown> }
          : {}),
      };
      await tx
        .update(erpEngineAssemblyBom)
        .set({
          version: item.bomId ? (await tx.select({ version: erpEngineAssemblyBom.version }).from(erpEngineAssemblyBom).where(eq(erpEngineAssemblyBom.id, bomId)).limit(1))[0]!.version + 1 : 1,
          defaultVariantKey: variantKey,
          executionProfileJson: JSON.stringify(profile),
          updatedAt: now,
        })
        .where(eq(erpEngineAssemblyBom.id, bomId));

      await tx
        .update(erpEngineAssemblyBomBrandLinks)
        .set({ isDefaultForBrand: false, updatedAt: now })
        .where(and(inArray(erpEngineAssemblyBomBrandLinks.engineBrandId, item.brandIds as any), isNull(erpEngineAssemblyBomBrandLinks.deletedAt)));
      await tx
        .update(erpEngineAssemblyBomBrandLinks)
        .set({ isDefaultForBrand: true, updatedAt: now })
        .where(
          and(
            eq(erpEngineAssemblyBomBrandLinks.bomId, bomId),
            inArray(erpEngineAssemblyBomBrandLinks.engineBrandId, item.brandIds as any),
            isNull(erpEngineAssemblyBomBrandLinks.deletedAt),
          ),
        );
      await tx
        .update(workOrderTemplates)
        .set({ archivedAt: now, updatedAt: now, updatedBy: 'migration:assembly-template-to-bom' })
        .where(eq(workOrderTemplates.id, templateId));
    }
  });
  console.log(`[apply] Перенесено и архивировано сборочных шаблонов: ${prepared.length}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
