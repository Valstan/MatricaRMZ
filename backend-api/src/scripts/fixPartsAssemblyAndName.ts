import { and, eq, inArray, isNull } from 'drizzle-orm';

import { EntityTypeCode } from '@matricarmz/shared';

import type { AuthUser } from '../auth/jwt.js';
import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import { updatePartAttribute } from '../services/partsService.js';

type PartFixResult = {
  partId: string;
  oldName: string | null;
  newName: string | null;
  oldAssembly: string | null;
  newAssembly: string | null;
  changedName: boolean;
  changedAssembly: boolean;
};

function cleanCell(value: string): string {
  return String(value ?? '')
    .replaceAll('\ufeff', '')
    .replaceAll('\u00a0', ' ')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function parseAttributeText(valueJson: string | null | undefined): string | null {
  if (valueJson == null) return null;
  try {
    const parsed = JSON.parse(String(valueJson));
    if (typeof parsed !== 'string') return null;
    const normalized = cleanCell(parsed);
    return normalized || null;
  } catch {
    const fallback = cleanCell(String(valueJson));
    return fallback || null;
  }
}

function normalizeForCompare(value: string | null): string {
  return cleanCell(value ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-яА-ЯёЁ]+/g, '');
}

function cleanAssemblySuffixes(value: string): string {
  return cleanCell(value)
    .replace(/\(\s*100\s*%?\s*зам[^)]*\)\s*$/i, '')
    .replace(/\s*\(\s*\d+\s*шт\.?\s*\)\s*$/i, '')
    .replace(/,\s*\d+\s*шт\.?\s*$/i, '')
    .replace(/\s+\d+\s*шт\.?\s*$/i, '')
    .replace(/,\s*\d+\s*$/i, '')
    .trim();
}

function cleanPartName(value: string): string {
  return cleanCell(value)
    .replace(/\(\s*100\s*%?\s*зам[^)]*\)\s*$/i, '')
    .replace(/\s*\(\s*\d+\s*шт\.?\s*\)\s*$/i, '')
    .replace(/,\s*\d+\s*шт\.?\s*$/i, '')
    .replace(/\s+\d+\s*шт\.?\s*$/i, '')
    .replace(/\s+\d+\s*$/i, '')
    .replace(/,\s*$/, '')
    .trim();
}

type AssemblyParseResult = {
  assemblyUnitNumber: string;
  extractedName: string | null;
  shouldUpdateAssembly: boolean;
};

type NameAssemblyParseResult = {
  assemblyUnitNumber: string;
  extractedName: string | null;
};

function splitAssemblyAndName(rawAssembly: string): AssemblyParseResult {
  const cleanedAssembly = cleanAssemblySuffixes(rawAssembly);
  if (!cleanedAssembly) {
    return { assemblyUnitNumber: '', extractedName: null, shouldUpdateAssembly: false };
  }

  const match = cleanedAssembly.match(/^(?:Сб\.?\s*)?([0-9][0-9A-Za-zА-Яа-я./-]+)\s+([А-ЯA-ZЁа-яё0-9].+)$/i);
  if (!match?.[1]) {
    return { assemblyUnitNumber: cleanedAssembly, extractedName: null, shouldUpdateAssembly: false };
  }

  const rawAssemblyUnitNumber = cleanCell(match[1]).replace(/,$/, '');
  const rawRemainder = match[2] == null ? '' : cleanCell(match[2]);
  if (!rawRemainder) {
    return { assemblyUnitNumber: rawAssemblyUnitNumber || cleanedAssembly, extractedName: null, shouldUpdateAssembly: false };
  }

  const looksLikeQuantityOnly = /^\d+\s*(?:шт\.?)?\s*$/i.test(rawRemainder);
  const looksLikeCodeOnly = /^[\d./-]+$/.test(rawRemainder);
  if (looksLikeCodeOnly && !looksLikeQuantityOnly) {
    return {
      assemblyUnitNumber: rawAssemblyUnitNumber || cleanedAssembly,
      extractedName: null,
      shouldUpdateAssembly: false,
    };
  }

  const looksLikeAdditionalAssembly = /(?:^|[\s,;])(и|или)\s+(сб\.?|[0-9])/i.test(rawRemainder) || /\bсб\./i.test(rawRemainder);
  const extractedName = cleanPartName(rawRemainder);
  if (!extractedName || looksLikeAdditionalAssembly) {
    return {
      assemblyUnitNumber: rawAssemblyUnitNumber || cleanedAssembly,
      extractedName: null,
      shouldUpdateAssembly: looksLikeQuantityOnly,
    };
  }

  return {
    assemblyUnitNumber: rawAssemblyUnitNumber || cleanedAssembly,
    extractedName,
    shouldUpdateAssembly: true,
  };
}

function splitNameWithEmbeddedAssembly(rawName: string): NameAssemblyParseResult | null {
  const cleanedName = cleanAssemblySuffixes(rawName);
  if (!cleanedName) return null;

  const match = cleanedName.match(/^(?:Сб\.?\s*)?([0-9][0-9A-Za-zА-Яа-я./-]+)\s+([А-ЯA-ZЁа-яё0-9].+)$/i);
  if (!match?.[1]) {
    return null;
  }

  const rawAssemblyUnitNumber = cleanCell(match[1]).replace(/,$/, '');
  const rawRemainder = match[2] == null ? '' : cleanCell(match[2]);
  if (!rawRemainder) {
    return { assemblyUnitNumber: rawAssemblyUnitNumber, extractedName: null };
  }

  const looksLikeQuantityOnly = /^\d+\s*(?:шт\.?)?\s*$/i.test(rawRemainder);
  const looksLikeCodeOnly = /^[\d./-]+$/.test(rawRemainder);
  if (looksLikeCodeOnly && !looksLikeQuantityOnly) {
    return { assemblyUnitNumber: rawAssemblyUnitNumber, extractedName: null };
  }

  const looksLikeAdditionalAssembly = /(?:^|[\s,;])(и|или)\s+(сб\.?|[0-9])/i.test(rawRemainder) || /\bсб\./i.test(rawRemainder);
  const extractedName = cleanPartName(rawRemainder);

  if (!extractedName || looksLikeAdditionalAssembly) {
    return { assemblyUnitNumber: rawAssemblyUnitNumber, extractedName: null };
  }

  return { assemblyUnitNumber: rawAssemblyUnitNumber, extractedName };
}

async function ensureSuperadminActor(): Promise<AuthUser> {
  const id = await getSuperadminUserId();
  if (!id) throw new Error('Не найден superadmin user');
  return { id, username: 'superadmin', role: 'superadmin' } as AuthUser;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const actor = await ensureSuperadminActor();

  const partTypeRows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, EntityTypeCode.Part), isNull(entityTypes.deletedAt)))
    .limit(1);
  const partTypeId = partTypeRows[0]?.id;
  if (!partTypeId) throw new Error('Не найден тип сущности Деталь');

  const partAttrRows = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, String(partTypeId)), isNull(attributeDefs.deletedAt)))
    .limit(5000);

  const nameDefId = partAttrRows.find((row) => String(row.code) === 'name')?.id;
  const assemblyDefId = partAttrRows.find((row) => String(row.code) === 'assembly_unit_number')?.id;
  if (!assemblyDefId) throw new Error('Не найдено поле "assembly_unit_number" у типа Деталь');
  if (!nameDefId) throw new Error('Не найдено поле "name" у типа Деталь');

  const partRows = await db
    .select({ id: entities.id })
    .from(entities)
    .where(and(eq(entities.typeId, String(partTypeId)), isNull(entities.deletedAt)))
    .limit(500_000);
  const partIds = partRows.map((row) => String(row.id));

  if (partIds.length === 0) {
    console.log(JSON.stringify({ ok: true, dryRun, scannedParts: 0, changed: 0, skipped: 0 }, null, 2));
    return;
  }

  const valueRows = await db
    .select({ entityId: attributeValues.entityId, attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .where(
      and(
        inArray(attributeValues.entityId, partIds as any),
        inArray(attributeValues.attributeDefId, [String(nameDefId), String(assemblyDefId)] as any),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1_000_000);

  const namesByPart = new Map<string, string | null>();
  const assembliesByPart = new Map<string, string | null>();
  for (const row of valueRows as Array<{ entityId: string; attributeDefId: string; valueJson: string | null }>) {
    const entityId = String(row.entityId);
    if (String(row.attributeDefId) === String(nameDefId)) {
      namesByPart.set(entityId, parseAttributeText(row.valueJson));
    }
    if (String(row.attributeDefId) === String(assemblyDefId)) {
      assembliesByPart.set(entityId, parseAttributeText(row.valueJson));
    }
  }

  const report: {
    scannedParts: number;
    candidatesWithEmbeddedName: number;
    updatesPlanned: number;
    assemblyUpdated: number;
    nameUpdated: number;
    skippedNoAssemblyField: number;
    skippedNameExists: number;
    failures: Array<{ partId: string; field: string; error: string }>;
    dryRun: boolean;
    changedRows: PartFixResult[];
  } = {
    scannedParts: partRows.length,
    candidatesWithEmbeddedName: 0,
    updatesPlanned: 0,
    assemblyUpdated: 0,
    nameUpdated: 0,
    skippedNoAssemblyField: 0,
    skippedNameExists: 0,
    failures: [],
    dryRun,
    changedRows: [],
  };

  for (const row of partRows as Array<{ id: string }>) {
    const partId = String(row.id);
    const currentName = namesByPart.get(partId) ?? null;
    const currentAssembly = assembliesByPart.get(partId) ?? null;

  const currentAssemblyProvided = Boolean(currentAssembly);
  const normalizedCurrentAssembly = currentAssemblyProvided ? cleanAssemblySuffixes(currentAssembly || '') : '';

    let parsed = currentAssembly ? splitAssemblyAndName(currentAssembly) : null;
    if (!parsed && currentAssemblyProvided) continue;

    if (!currentAssemblyProvided && currentName) {
      const parsedFromName = splitNameWithEmbeddedAssembly(currentName);
      if (parsedFromName) {
        parsed = {
          assemblyUnitNumber: parsedFromName.assemblyUnitNumber,
          extractedName: parsedFromName.extractedName,
          shouldUpdateAssembly: true,
        };
      }
    }

    if (!parsed || !parsed.assemblyUnitNumber) {
      report.skippedNoAssemblyField += 1;
      continue;
    }

    const cleanedAssembly = parsed.assemblyUnitNumber;
    const extractedName = parsed.extractedName;

    const shouldUpdateAssembly = (currentAssemblyProvided ? parsed.shouldUpdateAssembly : true) && cleanedAssembly !== normalizedCurrentAssembly;
    const shouldUpdateName = (() => {
      if (!currentAssemblyProvided && !extractedName) return true;
      if (!extractedName) return false;

      const existingName = cleanCell(currentName ?? '');
      const existingNormalized = normalizeForCompare(existingName);
      const existingLooksLikeAssembly = existingNormalized === normalizeForCompare(normalizedCurrentAssembly);

      if (!existingName) return true;
      if (existingLooksLikeAssembly) return true;
      return existingName !== extractedName && normalizeForCompare(extractedName) !== existingNormalized;
    })();

    if (!shouldUpdateAssembly && !shouldUpdateName) continue;

    if (extractedName) report.candidatesWithEmbeddedName += 1;

    const changes: PartFixResult = {
      partId,
      oldName: currentName,
      newName: currentName,
      oldAssembly: currentAssembly,
      newAssembly: currentAssembly,
      changedName: false,
      changedAssembly: false,
    };

    if (shouldUpdateName) {
      const newNameValue = extractedName ?? '';
      changes.changedName = true;
      changes.newName = extractedName ?? null;
      report.nameUpdated += 1;
      report.updatesPlanned += 1;
      if (!dryRun) {
        const updateResult = await updatePartAttribute({
          partId,
          attributeCode: 'name',
          value: newNameValue,
          actor,
        });
        if (!updateResult.ok) {
          report.failures.push({ partId, field: 'name', error: String(updateResult.error || 'unknown') });
          changes.changedName = false;
          report.nameUpdated -= 1;
        }
      }
    } else if (extractedName) {
      report.skippedNameExists += 1;
    }

    if (shouldUpdateAssembly) {
      changes.changedAssembly = true;
      changes.newAssembly = cleanedAssembly;
      report.assemblyUpdated += 1;
      report.updatesPlanned += 1;
      if (!dryRun) {
        const updateResult = await updatePartAttribute({
          partId,
          attributeCode: 'assembly_unit_number',
          value: cleanedAssembly,
          actor,
        });
        if (!updateResult.ok) {
          report.failures.push({
            partId,
            field: 'assembly_unit_number',
            error: String(updateResult.error || 'unknown'),
          });
          changes.changedAssembly = false;
          report.assemblyUpdated -= 1;
        }
      }
    }

    if (changes.changedName || changes.changedAssembly) {
      report.changedRows.push(changes);
    }
  }

  console.log(
    JSON.stringify(
      {
        ...report,
        changedRows: report.changedRows.map((row) => ({
          ...row,
          oldName: row.changedName ? row.oldName : null,
          newName: row.changedName ? row.newName : null,
          oldAssembly: row.changedAssembly ? row.oldAssembly : null,
          newAssembly: row.changedAssembly ? row.newAssembly : null,
        })),
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error) }, null, 2));
  process.exit(1);
});
