// Engine duplicate auto-merge (owner batch task 1, gate stage).
//
// A duplicate is born on sync-merge when two offline clients create "the same"
// engine, so a write-time gate alone cannot prevent it. This service is the
// backstop: a periodic in-process pass (primary instance only) that merges
// duplicate groups by the canonical key normalizeLookupCompact(engine_number)
// and surfaces what it did as a critical event. Running inside the backend
// process avoids the LedgerStore multi-process write race that bit the
// standalone CLI run (see PENDING_FOLLOWUPS «LedgerStore: writeFileSync без
// локов»).
//
// Merge semantics per group: survivor = most alive operations, tie -> oldest;
// losers' operations are repointed to the survivor; survivor's empty attrs are
// filled from losers; conflicting attrs resolve to the most recently created
// record when preferNewer is set (the late duplicate usually carries the
// current repair contract). Losers get a merged_into EAV attr (tombstone) and
// are soft-deleted. A separate step repoints stray operations that offline
// clients pushed against merged-away engines after the merge.
import { SyncTableName, normalizeLookupCompact, damerauLevenshtein } from '@matricarmz/shared';
import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, isNotNull } from 'drizzle-orm';

import { db } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes, operations } from '../database/schema.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';
import { setEntityAttribute, softDeleteEntity } from './adminMasterdataService.js';
import { ingestServerCriticalEvent } from './criticalEventsService.js';
import { recordSyncChanges } from './sync/syncChangeService.js';

const MERGED_INTO_CODE = 'merged_into';

type Actor = { id: string; username: string; role: string };

export type EngineDedupeResult = {
  groups: number;
  opsRepointed: number;
  strayOpsRepointed: number;
  attrsFilled: number;
  losersDeleted: number;
  conflicts: string[];
  log: string[];
};

function nowMs() {
  return Date.now();
}

function parseAttr(valueJson: string | null | undefined): string {
  if (valueJson == null) return '';
  try {
    const parsed = JSON.parse(String(valueJson));
    if (parsed == null) return '';
    return typeof parsed === 'string' ? parsed.trim() : JSON.stringify(parsed);
  } catch {
    return String(valueJson).trim();
  }
}

function operationPayload(row: typeof operations.$inferSelect) {
  return {
    id: String(row.id),
    engine_entity_id: String(row.engineEntityId),
    operation_type: String(row.operationType),
    status: String(row.status),
    note: row.note ?? null,
    performed_at: row.performedAt ?? null,
    performed_by: row.performedBy ?? null,
    meta_json: row.metaJson ?? null,
    created_at: Number(row.createdAt),
    updated_at: Number(row.updatedAt),
    deleted_at: row.deletedAt == null ? null : Number(row.deletedAt),
    sync_status: 'synced',
  };
}

export async function resolveEmployeeIdByLogin(login: string): Promise<string | null> {
  const employeeType = (
    await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(and(eq(entityTypes.code, 'employee'), isNull(entityTypes.deletedAt)))
      .limit(1)
  )[0];
  if (!employeeType) return null;
  const loginDef = (
    await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(
        and(
          eq(attributeDefs.entityTypeId, String(employeeType.id) as never),
          eq(attributeDefs.code, 'login'),
          isNull(attributeDefs.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  if (!loginDef) return null;
  const row = (
    await db
      .select({ entityId: attributeValues.entityId })
      .from(attributeValues)
      .innerJoin(entities, eq(entities.id, attributeValues.entityId))
      .where(
        and(
          eq(attributeValues.attributeDefId, String(loginDef.id) as never),
          eq(attributeValues.valueJson, JSON.stringify(login)),
          isNull(attributeValues.deletedAt),
          isNull(entities.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  return row ? String(row.entityId) : null;
}

async function ensureMergedIntoDef(engineTypeId: string): Promise<string> {
  const existing = (
    await db
      .select({ id: attributeDefs.id })
      .from(attributeDefs)
      .where(
        and(
          eq(attributeDefs.entityTypeId, engineTypeId as never),
          eq(attributeDefs.code, MERGED_INTO_CODE),
          isNull(attributeDefs.deletedAt),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return String(existing.id);
  const ts = nowMs();
  const id = randomUUID();
  await db.insert(attributeDefs).values({
    id,
    entityTypeId: engineTypeId as never,
    code: MERGED_INTO_CODE,
    name: 'Влит в (id двигателя)',
    dataType: 'text',
    sortOrder: 9000,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  return id;
}

/**
 * Repoint alive operations that reference merged-away (soft-deleted with
 * merged_into) engines — offline clients keep pushing acts against the old id
 * after the server has merged it.
 */
async function repointStrayOperations(actor: Actor, engineTypeId: string, mergedIntoDefId: string): Promise<number> {
  const tombstones = await db
    .select({ entityId: attributeValues.entityId, valueJson: attributeValues.valueJson })
    .from(attributeValues)
    .innerJoin(entities, eq(entities.id, attributeValues.entityId))
    .where(
      and(
        eq(attributeValues.attributeDefId, mergedIntoDefId as never),
        eq(entities.typeId, engineTypeId as never),
        isNull(attributeValues.deletedAt),
        isNotNull(entities.deletedAt),
      ),
    );
  if (tombstones.length === 0) return 0;
  const targetByLoser = new Map<string, string>();
  for (const t of tombstones) {
    const target = parseAttr(t.valueJson);
    if (target) targetByLoser.set(String(t.entityId), target);
  }
  const resolveTarget = (id: string): string => {
    let cur = id;
    for (let i = 0; i < 5; i += 1) {
      const next = targetByLoser.get(cur);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };

  const loserIds = [...targetByLoser.keys()];
  const strayOps = await db
    .select()
    .from(operations)
    .where(and(inArray(operations.engineEntityId, loserIds as never[]), isNull(operations.deletedAt)));
  let moved = 0;
  for (const op of strayOps) {
    const target = resolveTarget(String(op.engineEntityId));
    if (!target || target === String(op.engineEntityId)) continue;
    const ts = nowMs();
    await db
      .update(operations)
      .set({ engineEntityId: target as never, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(operations.id, op.id));
    await recordSyncChanges(
      actor,
      [
        {
          tableName: SyncTableName.Operations,
          rowId: String(op.id),
          op: 'upsert',
          payload: operationPayload({ ...op, engineEntityId: target as never, updatedAt: ts }),
        },
      ],
      { allowSyncConflicts: true },
    );
    moved += 1;
  }
  return moved;
}

export async function runEngineDedupePass(opts: {
  apply: boolean;
  preferNewer: boolean;
  actorLogin: string;
}): Promise<EngineDedupeResult> {
  const out: EngineDedupeResult = {
    groups: 0,
    opsRepointed: 0,
    strayOpsRepointed: 0,
    attrsFilled: 0,
    losersDeleted: 0,
    conflicts: [],
    log: [],
  };
  const say = (line: string) => out.log.push(line);

  const actorId = await resolveEmployeeIdByLogin(opts.actorLogin);
  if (!actorId) throw new Error(`employee with login "${opts.actorLogin}" not found`);
  const actor: Actor = { id: actorId, username: `engine-dedupe(${opts.actorLogin})`, role: 'system' };

  const engineType = (
    await db
      .select({ id: entityTypes.id })
      .from(entityTypes)
      .where(and(eq(entityTypes.code, 'engine'), isNull(entityTypes.deletedAt)))
      .limit(1)
  )[0];
  if (!engineType) throw new Error('entity type "engine" not found');
  const typeId = String(engineType.id);

  const defs = await db
    .select({ id: attributeDefs.id, code: attributeDefs.code })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, typeId as never), isNull(attributeDefs.deletedAt)))
    .orderBy(asc(attributeDefs.sortOrder), asc(attributeDefs.code));
  const numberDef = defs.find((d) => String(d.code) === 'engine_number');
  if (!numberDef) throw new Error('attribute def "engine_number" not found');

  const engines = await db
    .select({ id: entities.id, createdAt: entities.createdAt })
    .from(entities)
    .where(and(eq(entities.typeId, typeId as never), isNull(entities.deletedAt)))
    .limit(200_000);
  const engineIds = engines.map((e) => String(e.id));
  const createdAtById = new Map(engines.map((e) => [String(e.id), Number(e.createdAt)]));

  const values = engineIds.length
    ? await db
        .select()
        .from(attributeValues)
        .where(
          and(
            inArray(attributeValues.entityId, engineIds as never[]),
            inArray(
              attributeValues.attributeDefId,
              defs.map((d) => String(d.id)) as never[],
            ),
            isNull(attributeValues.deletedAt),
          ),
        )
    : [];
  const attrsByEngine = new Map<string, Map<string, string>>();
  for (const v of values) {
    const eid = String(v.entityId);
    if (!attrsByEngine.has(eid)) attrsByEngine.set(eid, new Map());
    attrsByEngine.get(eid)!.set(String(v.attributeDefId), parseAttr(v.valueJson));
  }
  const codeByDefId = new Map(defs.map((d) => [String(d.id), String(d.code)]));

  const groups = new Map<string, string[]>();
  for (const eid of engineIds) {
    const num = attrsByEngine.get(eid)?.get(String(numberDef.id)) ?? '';
    const key = normalizeLookupCompact(num);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(eid);
  }
  const dupGroups = [...groups.entries()].filter(([, ids]) => ids.length > 1);
  out.groups = dupGroups.length;
  say(`engines alive: ${engines.length}; duplicate groups: ${dupGroups.length}`);

  const mergedIntoDefId = opts.apply && dupGroups.length > 0 ? await ensureMergedIntoDef(typeId) : null;

  for (const [key, ids] of dupGroups) {
    const opsCounts = new Map<string, number>();
    for (const eid of ids) {
      const rows = await db
        .select({ id: operations.id })
        .from(operations)
        .where(and(eq(operations.engineEntityId, eid as never), isNull(operations.deletedAt)));
      opsCounts.set(eid, rows.length);
    }
    const sorted = [...ids].sort((a, b) => {
      const byOps = (opsCounts.get(b) ?? 0) - (opsCounts.get(a) ?? 0);
      if (byOps !== 0) return byOps;
      return (createdAtById.get(a) ?? 0) - (createdAtById.get(b) ?? 0);
    });
    const survivor = sorted[0]!;
    const losers = sorted.slice(1);
    const survivorValByCode = new Map<string, string>();
    for (const [defId, val] of attrsByEngine.get(survivor) ?? new Map<string, string>()) {
      survivorValByCode.set(codeByDefId.get(defId) ?? defId, val);
    }

    say(`[${key}] survivor=${survivor} (ops=${opsCounts.get(survivor)}), losers=${losers.join(', ')}`);

    for (const loser of losers) {
      const loserOps = await db
        .select()
        .from(operations)
        .where(eq(operations.engineEntityId, loser as never));
      say(`  loser ${loser}: ops to repoint=${loserOps.length}`);
      out.opsRepointed += loserOps.length;

      const loserAttrs = attrsByEngine.get(loser) ?? new Map<string, string>();
      const fills: Array<{ code: string; value: string }> = [];
      for (const [defId, loserVal] of loserAttrs) {
        if (!loserVal) continue;
        const code = codeByDefId.get(defId) ?? defId;
        if (code === 'engine_number' || code === MERGED_INTO_CODE) continue;
        const survivorVal = survivorValByCode.get(code) ?? '';
        if (!survivorVal) {
          fills.push({ code, value: loserVal });
        } else if (survivorVal !== loserVal) {
          const loserIsNewer = (createdAtById.get(loser) ?? 0) > (createdAtById.get(survivor) ?? 0);
          if (opts.preferNewer && loserIsNewer) {
            fills.push({ code, value: loserVal });
            out.conflicts.push(`[${key}] ${code}: «${survivorVal}» → «${loserVal}» (prefer-newer)`);
          } else {
            out.conflicts.push(`[${key}] ${code}: survivor=«${survivorVal}» vs loser(${loser})=«${loserVal}»`);
          }
        }
      }
      if (fills.length) say(`  attr fills: ${fills.map((f) => `${f.code}=${f.value}`).join('; ')}`);
      out.attrsFilled += fills.length;

      if (!opts.apply) {
        out.losersDeleted += 1;
        continue;
      }

      const ts = nowMs();
      for (const op of loserOps) {
        await db
          .update(operations)
          .set({ engineEntityId: survivor as never, updatedAt: ts, syncStatus: 'synced' })
          .where(eq(operations.id, op.id));
        await recordSyncChanges(
          actor,
          [
            {
              tableName: SyncTableName.Operations,
              rowId: String(op.id),
              op: op.deletedAt == null ? 'upsert' : 'delete',
              payload: operationPayload({ ...op, engineEntityId: survivor as never, updatedAt: ts }),
            },
          ],
          { allowSyncConflicts: true },
        );
      }

      const tomb = await setEntityAttribute(actor, loser, MERGED_INTO_CODE, survivor, { allowSyncConflicts: true });
      if (!tomb.ok) say(`  !! tombstone failed for ${loser}: ${tomb.error}`);

      const del = await softDeleteEntity(actor, loser, { allowSyncConflicts: true });
      if (!del.ok) {
        say(`  !! soft-delete failed for ${loser}: ${del.error}`);
        continue;
      }
      out.losersDeleted += 1;

      for (const f of fills) {
        const res = await setEntityAttribute(actor, survivor, f.code, f.value, { allowSyncConflicts: true });
        if (!res.ok) say(`  !! attr fill failed (${f.code}): ${res.error}`);
        else survivorValByCode.set(f.code, f.value);
      }
    }
  }

  if (opts.apply) {
    const defId = mergedIntoDefId ?? (await ensureMergedIntoDef(typeId));
    out.strayOpsRepointed = await repointStrayOperations(actor, typeId, defId);
    if (out.strayOpsRepointed > 0) say(`stray operations repointed: ${out.strayOpsRepointed}`);
  }

  return out;
}

let dedupeJobRunning = false;

export function startEngineDedupeJob() {
  const enabled = String(process.env.MATRICA_ENGINE_DEDUPE_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) {
    logInfo('engine dedupe job disabled (MATRICA_ENGINE_DEDUPE_ENABLED=false)');
    return;
  }
  const intervalRaw = Number(process.env.MATRICA_ENGINE_DEDUPE_INTERVAL_MS ?? 3_600_000);
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw >= 60_000 ? intervalRaw : 3_600_000;
  const actorLogin = String(process.env.MATRICA_ENGINE_DEDUPE_ACTOR ?? 'valstan').trim() || 'valstan';

  const tick = async () => {
    if (dedupeJobRunning) return;
    dedupeJobRunning = true;
    try {
      const res = await runEngineDedupePass({ apply: true, preferNewer: true, actorLogin });
      if (res.groups > 0) {
        logWarn('engine dedupe pass merged duplicates', {
          groups: res.groups,
          ops: res.opsRepointed,
          stray: res.strayOpsRepointed,
          fills: res.attrsFilled,
          deleted: res.losersDeleted,
        });
        ingestServerCriticalEvent({
          eventCode: 'engine_duplicates_merged',
          title: 'Авто-склейка дублей двигателей',
          humanMessage:
            `Обнаружены и склеены дубли двигателей: групп ${res.groups}, актов перевешено ${res.opsRepointed}, ` +
            `записей удалено ${res.losersDeleted}.` +
            (res.conflicts.length ? ` Конфликтные поля (${res.conflicts.length}): ${res.conflicts.slice(0, 10).join('; ')}` : ''),
          category: 'database',
          severity: 'warn',
          aiDetails: { log: res.log.slice(0, 200), conflicts: res.conflicts },
        });
      } else if (res.strayOpsRepointed > 0) {
        logInfo('engine dedupe pass repointed stray operations', { stray: res.strayOpsRepointed });
      }
    } catch (e) {
      logError('engine dedupe pass failed', { error: String(e) });
    } finally {
      dedupeJobRunning = false;
    }
  };

  setTimeout(() => void tick(), 300_000);
  setInterval(() => void tick(), intervalMs);
  logInfo('engine dedupe job started', { intervalMs, actorLogin });
}

// ---------------------------------------------------------------------------
// Operator-driven dedupe (UI "Поиск дублей двигателей"): analyze groups for
// review + merge a group with an operator-chosen survivor. The periodic job
// above auto-merges EXACT groups; this surfaces SIMILAR (near-miss) groups the
// job can't safely touch, and lets the operator merge anything immediately.
// ---------------------------------------------------------------------------

export type EngineDupEngine = {
  id: string;
  engineNumber: string;
  engineBrand: string;
  createdAt: number;
  opsCount: number;
};
export type EngineDupGroup = { kind: 'exact' | 'similar'; engines: EngineDupEngine[] };

function editBudgetForKey(len: number): number {
  return len < 4 ? 0 : len <= 7 ? 1 : 2;
}

let dedupeAnalyzeRunning = false;

export async function analyzeEngineDuplicates(): Promise<
  { ok: true; totalEngines: number; groups: EngineDupGroup[] } | { ok: false; error: string }
> {
  if (dedupeAnalyzeRunning) return { ok: false as const, error: 'анализ дублей уже выполняется, подождите' };
  dedupeAnalyzeRunning = true;
  try {
    const engineType = (
      await db
        .select({ id: entityTypes.id })
        .from(entityTypes)
        .where(and(eq(entityTypes.code, 'engine'), isNull(entityTypes.deletedAt)))
        .limit(1)
    )[0];
    if (!engineType) return { ok: false as const, error: 'entity type "engine" not found' };
    const typeId = String(engineType.id);

    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId as never), isNull(attributeDefs.deletedAt)));
    const numberDef = defs.find((d) => String(d.code) === 'engine_number');
    const brandDef = defs.find((d) => String(d.code) === 'engine_brand');
    if (!numberDef) return { ok: false as const, error: 'attribute def "engine_number" not found' };

    const engines = await db
      .select({ id: entities.id, createdAt: entities.createdAt })
      .from(entities)
      .where(and(eq(entities.typeId, typeId as never), isNull(entities.deletedAt)))
      .limit(200_000);
    const engineIds = engines.map((e) => String(e.id));
    const createdAtById = new Map(engines.map((e) => [String(e.id), Number(e.createdAt)]));
    if (engineIds.length === 0) return { ok: true as const, totalEngines: 0, groups: [] };

    const wantDefIds = [String(numberDef.id), ...(brandDef ? [String(brandDef.id)] : [])];
    const values = await db
      .select()
      .from(attributeValues)
      .where(
        and(
          inArray(attributeValues.entityId, engineIds as never[]),
          inArray(attributeValues.attributeDefId, wantDefIds as never[]),
          isNull(attributeValues.deletedAt),
        ),
      );
    const numberById = new Map<string, string>();
    const brandById = new Map<string, string>();
    for (const v of values) {
      const eid = String(v.entityId);
      if (String(v.attributeDefId) === String(numberDef.id)) numberById.set(eid, parseAttr(v.valueJson));
      else if (brandDef && String(v.attributeDefId) === String(brandDef.id)) brandById.set(eid, parseAttr(v.valueJson));
    }

    // Canonical key per engine; engines sharing a key are exact duplicates.
    const keyById = new Map<string, string>();
    const enginesByKey = new Map<string, string[]>();
    for (const eid of engineIds) {
      const key = normalizeLookupCompact(numberById.get(eid) ?? '');
      if (!key) continue;
      keyById.set(eid, key);
      if (!enginesByKey.has(key)) enginesByKey.set(key, []);
      enginesByKey.get(key)!.push(eid);
    }

    // Union-find over DISTINCT keys: union near-miss keys (edit distance <= budget).
    // A cluster = transitively-near keys. Bucketed by length (±1) to bound the O(n^2).
    const keys = [...enginesByKey.keys()];
    const parent = new Map<string, string>(keys.map((k) => [k, k]));
    const find = (k: string): string => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let c = k;
      while (parent.get(c) !== c) {
        const n = parent.get(c)!;
        parent.set(c, r);
        c = n;
      }
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const byLen = new Map<number, string[]>();
    for (const k of keys) {
      if (!byLen.has(k.length)) byLen.set(k.length, []);
      byLen.get(k.length)!.push(k);
    }
    let cmpBudget = 8_000_000; // hard cap on damerauLevenshtein calls — bounds CPU on huge datasets
    let truncated = false;
    for (const k of keys) {
      const budget = editBudgetForKey(k.length);
      if (budget === 0) continue;
      // Window must span ±budget: a true distance-2 pair can differ in length by 2.
      const candidates: string[] = [];
      for (let l = k.length - budget; l <= k.length + budget; l += 1) {
        const bucket = byLen.get(l);
        if (bucket) candidates.push(...bucket);
      }
      for (const o of candidates) {
        if (o === k || find(o) === find(k)) continue;
        if (cmpBudget-- <= 0) {
          truncated = true;
          break;
        }
        const d = damerauLevenshtein(k, o, budget);
        if (d > 0 && d <= budget) union(k, o);
      }
      if (truncated) break;
    }
    if (truncated) logWarn('engine dedupe analyze: similar clustering truncated (comparison budget exhausted)');
    const clusterKeys = new Map<string, string[]>();
    for (const k of keys) {
      const r = find(k);
      if (!clusterKeys.has(r)) clusterKeys.set(r, []);
      clusterKeys.get(r)!.push(k);
    }

    // ops counts (single batched query) for every engine that lands in a group.
    const groupEngineIds = new Set<string>();
    for (const ks of clusterKeys.values()) {
      const ids = ks.flatMap((k) => enginesByKey.get(k) ?? []);
      if (ids.length >= 2) for (const id of ids) groupEngineIds.add(id);
    }
    const opsCountById = new Map<string, number>();
    if (groupEngineIds.size > 0) {
      const rows = await db
        .select({ engineEntityId: operations.engineEntityId })
        .from(operations)
        .where(and(inArray(operations.engineEntityId, [...groupEngineIds] as never[]), isNull(operations.deletedAt)));
      for (const r of rows) {
        const eid = String(r.engineEntityId);
        opsCountById.set(eid, (opsCountById.get(eid) ?? 0) + 1);
      }
    }
    const toEngine = (eid: string): EngineDupEngine => ({
      id: eid,
      engineNumber: numberById.get(eid) ?? '',
      engineBrand: brandById.get(eid) ?? '',
      createdAt: createdAtById.get(eid) ?? 0,
      opsCount: opsCountById.get(eid) ?? 0,
    });

    const groups: EngineDupGroup[] = [];
    for (const ks of clusterKeys.values()) {
      const ids = ks.flatMap((k) => enginesByKey.get(k) ?? []);
      if (ids.length < 2) continue;
      const kind: EngineDupGroup['kind'] = ks.length > 1 ? 'similar' : 'exact';
      const sortedEngines = ids.map(toEngine).sort((a, b) => b.opsCount - a.opsCount || a.createdAt - b.createdAt);
      groups.push({ kind, engines: sortedEngines });
    }
    // exact first, then similar; within a kind by group size desc.
    groups.sort((a, b) => (a.kind === b.kind ? b.engines.length - a.engines.length : a.kind === 'exact' ? -1 : 1));
    return { ok: true as const, totalEngines: engineIds.length, groups };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  } finally {
    dedupeAnalyzeRunning = false;
  }
}

export type EngineMergeReport = { survivorId: string; merged: Array<{ loserId: string; opsRepointed: number; attrsFilled: number }> };

/**
 * Operator-driven merge of a duplicate group: repoint every loser's operations to the
 * survivor, fill the survivor's EMPTY attributes from losers (never overwrite), tombstone
 * (merged_into) and soft-delete each loser. Mirrors the per-loser logic of the auto-pass
 * but with the survivor chosen explicitly by the operator. Stray offline pushes against a
 * just-merged loser are caught by the periodic job's repointStrayOperations.
 */
export async function mergeEngineGroup(args: {
  survivorId: string;
  loserIds: string[];
  actor: Actor;
}): Promise<{ ok: true; report: EngineMergeReport } | { ok: false; error: string }> {
  try {
    const survivorId = String(args.survivorId);
    const loserIds = [...new Set(args.loserIds.map(String))].filter((id) => id && id !== survivorId);
    if (!survivorId) return { ok: false as const, error: 'survivorId required' };
    if (loserIds.length === 0) return { ok: false as const, error: 'no losers to merge' };

    const engineType = (
      await db
        .select({ id: entityTypes.id })
        .from(entityTypes)
        .where(and(eq(entityTypes.code, 'engine'), isNull(entityTypes.deletedAt)))
        .limit(1)
    )[0];
    if (!engineType) return { ok: false as const, error: 'entity type "engine" not found' };
    const typeId = String(engineType.id);

    // Validate survivor + losers are alive engines of the engine type.
    const all = [survivorId, ...loserIds];
    const rows = await db
      .select({ id: entities.id })
      .from(entities)
      .where(and(inArray(entities.id, all as never[]), eq(entities.typeId, typeId as never), isNull(entities.deletedAt)));
    const aliveIds = new Set(rows.map((r) => String(r.id)));
    if (!aliveIds.has(survivorId)) return { ok: false as const, error: 'survivor is not an alive engine' };
    const validLosers = loserIds.filter((id) => aliveIds.has(id));
    if (validLosers.length === 0) return { ok: false as const, error: 'no alive losers' };

    const defs = await db
      .select({ id: attributeDefs.id, code: attributeDefs.code })
      .from(attributeDefs)
      .where(and(eq(attributeDefs.entityTypeId, typeId as never), isNull(attributeDefs.deletedAt)));
    const codeByDefId = new Map(defs.map((d) => [String(d.id), String(d.code)]));

    const loadAttrs = async (eid: string): Promise<Map<string, string>> => {
      const vals = await db
        .select()
        .from(attributeValues)
        .where(and(eq(attributeValues.entityId, eid as never), isNull(attributeValues.deletedAt)));
      const m = new Map<string, string>();
      for (const v of vals) m.set(codeByDefId.get(String(v.attributeDefId)) ?? String(v.attributeDefId), parseAttr(v.valueJson));
      return m;
    };
    const survivorAttrs = await loadAttrs(survivorId);

    // Ensure the merged_into tombstone def exists BEFORE writing tombstones — without it
    // setEntityAttribute rejects the write and repointStrayOperations could never reclaim
    // future offline pushes against the soft-deleted loser (it finds losers BY tombstone).
    const mergedIntoDefId = await ensureMergedIntoDef(typeId);

    const report: EngineMergeReport = { survivorId, merged: [] };
    for (const loser of validLosers) {
      const loserOps = await db.select().from(operations).where(eq(operations.engineEntityId, loser as never));
      const ts = nowMs();
      for (const op of loserOps) {
        await db
          .update(operations)
          .set({ engineEntityId: survivorId as never, updatedAt: ts, syncStatus: 'synced' })
          .where(eq(operations.id, op.id));
        await recordSyncChanges(
          args.actor,
          [
            {
              tableName: SyncTableName.Operations,
              rowId: String(op.id),
              op: op.deletedAt == null ? 'upsert' : 'delete',
              payload: operationPayload({ ...op, engineEntityId: survivorId as never, updatedAt: ts }),
            },
          ],
          { allowSyncConflicts: true },
        );
      }

      const loserAttrs = await loadAttrs(loser);
      let attrsFilled = 0;
      for (const [code, loserVal] of loserAttrs) {
        if (!loserVal || code === 'engine_number' || code === MERGED_INTO_CODE) continue;
        if ((survivorAttrs.get(code) ?? '') !== '') continue; // never overwrite a non-empty survivor attr
        const res = await setEntityAttribute(args.actor, survivorId, code, loserVal, { allowSyncConflicts: true });
        if (res.ok) {
          survivorAttrs.set(code, loserVal);
          attrsFilled += 1;
        }
      }

      const tomb = await setEntityAttribute(args.actor, loser, MERGED_INTO_CODE, survivorId, { allowSyncConflicts: true });
      if (!tomb.ok) {
        // No tombstone → stray reclaim is impossible; do NOT soft-delete this loser. Skip
        // it (ops are already repointed; a retry will finish it once the tombstone writes).
        continue;
      }
      const del = await softDeleteEntity(args.actor, loser, { allowSyncConflicts: true });
      if (!del.ok) continue; // one stuck loser must not block merging the rest of the group
      report.merged.push({ loserId: loser, opsRepointed: loserOps.length, attrsFilled });
    }

    // Reclaim operations offline clients pushed against a just-merged loser (mirrors the
    // auto-pass; uses the tombstone def ensured above).
    await repointStrayOperations(args.actor, typeId, mergedIntoDefId);

    ingestServerCriticalEvent({
      eventCode: 'engine_duplicates_merged',
      title: 'Ручная склейка дублей двигателей',
      humanMessage: `Оператор склеил дубли: survivor=${survivorId}, склеено ${report.merged.length}, актов перевешено ${report.merged.reduce((s, m) => s + m.opsRepointed, 0)}.`,
      category: 'database',
      severity: 'warn',
      aiDetails: { survivorId, losers: validLosers, actor: args.actor.username },
    });

    return { ok: true as const, report };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  }
}
