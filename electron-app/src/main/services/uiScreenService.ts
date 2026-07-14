import { randomUUID } from 'node:crypto';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, isNull } from 'drizzle-orm';

import { EntityTypeCode, type UiScreenListItem } from '@matricarmz/shared';

import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { setEntityAttribute, softDeleteEntity } from './entityService.js';

/**
 * Operator-built screens (UI builder pilot): EAV entity type `ui_screen`,
 * factory-wide via the regular sync. Section-access enforcement lives in the
 * IPC layer (register/uiScreens.ts) — this service is storage only.
 */

function safeParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function asText(value: unknown): string {
  // Tolerate double-encoded strings (EAV setAttr stringifies once more).
  let v = value;
  for (let depth = 0; typeof v === 'string' && depth < 2; depth += 1) {
    const s: string = v;
    if (!s.startsWith('"')) break;
    try {
      v = JSON.parse(s);
    } catch {
      break;
    }
  }
  return v == null ? '' : String(v);
}

async function uiScreenContext(db: BetterSQLite3Database) {
  const typeRows = await db
    .select()
    .from(entityTypes)
    .where(and(eq(entityTypes.code, EntityTypeCode.UiScreen), isNull(entityTypes.deletedAt)))
    .limit(1);
  const typeId = typeRows[0]?.id ? String(typeRows[0].id) : null;
  if (!typeId) return null;
  const defs = await db
    .select()
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId), isNull(attributeDefs.deletedAt)));
  const defIdByCode: Record<string, string> = {};
  for (const d of defs) defIdByCode[String(d.code)] = String(d.id);
  return { typeId, defIdByCode };
}

type ScreenRow = Omit<UiScreenListItem, 'canEdit'> & { specJson: string };

async function readScreens(db: BetterSQLite3Database, onlyId?: string): Promise<ScreenRow[]> {
  const ctxInfo = await uiScreenContext(db);
  if (!ctxInfo) return [];
  const where = onlyId
    ? and(eq(entities.typeId, ctxInfo.typeId), eq(entities.id, onlyId), isNull(entities.deletedAt))
    : and(eq(entities.typeId, ctxInfo.typeId), isNull(entities.deletedAt));
  const rows = await db.select().from(entities).where(where).limit(2000);
  if (rows.length === 0) return [];

  const out: ScreenRow[] = [];
  for (const e of rows) {
    const values = await db
      .select({ attributeDefId: attributeValues.attributeDefId, valueJson: attributeValues.valueJson })
      .from(attributeValues)
      .where(and(eq(attributeValues.entityId, String(e.id)), isNull(attributeValues.deletedAt)));
    const byDefId = new Map(values.map((v) => [String(v.attributeDefId), v.valueJson ? String(v.valueJson) : null]));
    const attr = (code: string): unknown => {
      const defId = ctxInfo.defIdByCode[code];
      return defId ? safeParse(byDefId.get(defId) ?? null) : null;
    };
    const specRaw = attr('spec_json');
    out.push({
      id: String(e.id),
      name: asText(attr('name')),
      sectionId: asText(attr('section_id')),
      createdBy: asText(attr('created_by')),
      updatedAt: Number(e.updatedAt),
      specJson: typeof specRaw === 'string' ? specRaw : specRaw != null ? JSON.stringify(specRaw) : '',
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listUiScreens(db: BetterSQLite3Database): Promise<ScreenRow[]> {
  return readScreens(db);
}

export async function getUiScreen(db: BetterSQLite3Database, id: string): Promise<ScreenRow | null> {
  const rows = await readScreens(db, String(id ?? '').trim());
  return rows[0] ?? null;
}

export async function saveUiScreen(
  db: BetterSQLite3Database,
  args: { id?: string; name: string; sectionId: string; specJson: string; createdBy: string },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const ctxInfo = await uiScreenContext(db);
  if (!ctxInfo) return { ok: false, error: 'Тип «Экраны оператора» не найден — перезапустите приложение (seed)' };
  const id = String(args.id ?? '').trim() || randomUUID();
  const isNew = !args.id;
  const writes: Array<[string, unknown]> = [
    ['name', args.name],
    ['section_id', args.sectionId],
    ['spec_json', args.specJson],
    ...(isNew ? ([['created_by', args.createdBy]] as Array<[string, unknown]>) : []),
  ];
  for (const [code, value] of writes) {
    const res = await setEntityAttribute(db, id, code, value, ctxInfo.typeId);
    if (!res.ok) return { ok: false, error: res.error ?? `Не удалось сохранить ${code}` };
  }
  return { ok: true, id };
}

export async function deleteUiScreen(db: BetterSQLite3Database, id: string) {
  return softDeleteEntity(db, String(id ?? '').trim());
}
