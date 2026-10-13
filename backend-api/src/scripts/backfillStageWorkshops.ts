import 'dotenv/config';

import {
  parseRepairHistoryMeta,
  SyncTableName,
  SyncTableRegistry,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';
import { camelOperationRowForSync } from './pr3SyncRow.js';

// workshops:backfill-stage-workshops — проставить цех строкам этапов, где его нет:
// сборка (`sborka`) → цех с кодом '1', обкатка (`obkatka`) → цех с кодом '2'
// (решение владельца 13.10.2026). Плюс нормализация legacy-текста в `workshopId`
// (ранние этапы писали цех вручную строкой, а не uuid из `directory_workshops`)
// и добивка отсутствующего снимка имени.
//
// Правила:
//   - пустой цех + код sborka/obkatka (строка этапа ИЛИ строка работ) → цех + снимок;
//   - пустой цех + другой код → не трогаем (правила нет), только считаем;
//   - не-этап (ручная запись, статус, переезд) → не трогаем;
//   - uuid из справочника + нет/старое имя → добить/обновить снимок;
//   - legacy-текст → uuid по совпадению (код, имя, «цех N»); не совпало → список, не трогаем;
//   - дефолты видов работ sborka/obkatka в `work_sheet_types` (вне синка): пустые → проставить,
//     чужие — список, не трогаем;
//   - только ЖИВЫЕ двигатели; идемпотентно (повтор → 0); запись через writeSyncChanges
//     (журнал + seq) — парк видит обычным pull.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api workshops:backfill-stage-workshops            # dry-run
//   corepack pnpm -F @matricarmz/backend-api workshops:backfill-stage-workshops -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Прод-гейт #025: --apply только после того, как владелец видел конкретный список из dry-run.
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'workshops:backfill-stage-workshops', role: 'system' };

/** Цех сборки и цех обкатки — кодами справочника (id резолвятся из базы, не зашиты). */
const RULE_BY_CODE: Record<string, string> = { sborka: '1', obkatka: '2' };

type RawRow = Record<string, unknown>;

export type WorkshopDir = { id: string; code: string; name: string };

export type BackfillVerdict =
  | { action: 'skip-not-stage' }
  | { action: 'skip-no-rule'; code: string }
  | { action: 'skip-has-workshop' }
  | { action: 'fill'; workshopId: string; workshopName: string }
  | { action: 'normalize'; workshopId: string; workshopName: string }
  | { action: 'name-fill'; workshopName: string }
  | { action: 'unmatched'; workshopId: string };

function normText(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll('№', '')
    .replace(/\s+/g, ' ');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Индекс справочника для нормализации legacy-текста: код, имя, имя без пробелов,
 * «цех <код>» в обе стороны. Первое совпадение побеждает; дубли кодов — fail closed
 * (скрипт падает до записи, а не гадает).
 */
export function buildWorkshopIndex(dir: WorkshopDir[]): Map<string, WorkshopDir> {
  const idx = new Map<string, WorkshopDir>();
  for (const w of dir) {
    const code = normText(w.code);
    const name = normText(w.name);
    const nospace = name.replace(/ /g, '');
    for (const key of [code, name, nospace, `цех ${code}`, `цех${code}`, `цех ${name}`, `цех${nospace}`]) {
      if (!key) continue;
      const prev = idx.get(key);
      if (prev && prev.id !== w.id) throw new Error(`справочник цехов неоднозначен по ключу «${key}» — нужна ручная сверка`);
      idx.set(key, w);
    }
  }
  return idx;
}

export function matchWorkshop(rawId: string, byId: Map<string, WorkshopDir>, byText: Map<string, WorkshopDir>): WorkshopDir | null {
  const id = String(rawId ?? '').trim();
  if (!id) return null;
  if (UUID_RE.test(id)) return byId.get(id.toLowerCase()) ?? null;
  return byText.get(normText(id)) ?? null;
}

/**
 * Решение по строке этапа: чистый предикат ради теста. `code` — код этапа/вида работ
 * нижним регистром (пусто — не этап), `workshopId`/`workshopName` — сырые из meta.
 */
export function decideStageWorkshop(
  args: { code: string; workshopId: string; workshopName: string },
  dir: { byId: Map<string, WorkshopDir>; byText: Map<string, WorkshopDir>; byCode: Map<string, WorkshopDir> },
): BackfillVerdict {
  const code = String(args.code ?? '').trim().toLowerCase();
  if (!code) return { action: 'skip-not-stage' };
  const wsId = String(args.workshopId ?? '').trim();
  const wsName = String(args.workshopName ?? '').trim();
  if (!wsId) {
    const wantCode = RULE_BY_CODE[code];
    if (!wantCode) return { action: 'skip-no-rule', code };
    const w = dir.byCode.get(wantCode);
    if (!w) throw new Error(`в справочнике нет цеха с кодом '${wantCode}' — правило для '${code}' некуда применить`);
    return { action: 'fill', workshopId: w.id, workshopName: w.name };
  }
  const known = matchWorkshop(wsId, dir.byId, dir.byText);
  if (!known) return { action: 'unmatched', workshopId: wsId };
  if (known.id.toLowerCase() === wsId.toLowerCase() && UUID_RE.test(wsId)) {
    return wsName === known.name ? { action: 'skip-has-workshop' } : { action: 'name-fill', workshopName: known.name };
  }
  return { action: 'normalize', workshopId: known.id, workshopName: known.name };
}

/** Строка operations (snake_case из pg) → payload журнала. */
function toSyncRow(raw: RawRow): Record<string, unknown> {
  return SyncTableRegistry.toSyncRow(SyncTableName.Operations, camelOperationRowForSync(raw)) as Record<string, unknown>;
}

/** Разбор `meta_json` строки как сырого объекта (не теряет незнакомые поля). */
function rawMetaOf(raw: RawRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw.meta_json ?? 'null'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function reload(id: string): Promise<RawRow | null> {
  const found = (await pool.query(`SELECT * FROM operations WHERE id = $1`, [id])) as { rows: RawRow[] };
  return found.rows[0] ?? null;
}

function parseArgs(argv: string[]): { apply: boolean; engine: string | null } {
  const out = { apply: false, engine: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--engine') out.engine = String(argv[++i] ?? '').trim() || null;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`workshops:backfill-stage-workshops — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const dirRes = (await pool.query(
    `SELECT id::text AS id, code::text AS code, name::text AS name FROM directory_workshops WHERE deleted_at IS NULL`,
  )) as { rows: WorkshopDir[] };
  const dir = dirRes.rows.filter((w) => w.id && w.code && w.name);
  if (dir.length === 0) throw new Error('справочник цехов пуст — некуда проставлять');
  const byId = new Map(dir.map((w) => [w.id.toLowerCase(), w]));
  const byCode = new Map(dir.map((w) => [normText(w.code), w]));
  const byText = buildWorkshopIndex(dir);
  console.log(`Цеха справочника: ${dir.map((w) => `${w.code}=«${w.name}»`).join(', ')}`);

  const engineFilter = args.engine ? ' AND engine_entity_id = $1' : '';
  const params: unknown[] = args.engine ? [args.engine] : [];
  const found = (await pool.query(
    `SELECT * FROM operations
       WHERE operation_type = 'repair_history_entry' AND deleted_at IS NULL${engineFilter}`,
    params,
  )) as { rows: RawRow[] };

  // Живые двигатели: мягко удалённые пропускаем.
  const engineIds = [...new Set(found.rows.map((r) => String(r.engine_entity_id ?? '')).filter(Boolean))];
  const live = new Set<string>();
  for (let i = 0; i < engineIds.length; i += 500) {
    const chunk = engineIds.slice(i, i + 500);
    const res = (await pool.query(`SELECT id::text AS id FROM entities WHERE id = ANY($1) AND deleted_at IS NULL`, [
      chunk,
    ])) as { rows: Array<{ id: string }> };
    for (const r of res.rows) live.add(String(r.id));
  }

  const ts = Date.now();
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
    pending = [];
  };

  const counts = { fill: 0, normalize: 0, nameFill: 0, skipRule: 0, skipStage: 0, skipOk: 0, skipDeleted: 0 };
  const unmatched: Array<{ id: string; engine: string; code: string; workshopId: string }> = [];
  const noRule: Array<{ id: string; engine: string; code: string }> = [];

  for (const raw of found.rows) {
    const engineId = String(raw.engine_entity_id ?? '');
    if (!live.has(engineId)) {
      counts.skipDeleted += 1;
      continue;
    }
    const meta = parseRepairHistoryMeta(typeof raw.meta_json === 'string' ? raw.meta_json : null);
    if (!meta) continue;
    const code = meta.stage ? String(meta.stage.code ?? '') : meta.sheet ? String(meta.sheet.typeCode ?? '') : '';
    const id = String(raw.id ?? '');
    const verdict = decideStageWorkshop(
      { code, workshopId: String(meta.workshopId ?? ''), workshopName: String(meta.workshopName ?? '') },
      { byId, byText, byCode },
    );
    switch (verdict.action) {
      case 'skip-not-stage':
        counts.skipStage += 1;
        continue;
      case 'skip-no-rule':
        counts.skipRule += 1;
        if (noRule.length < 20) noRule.push({ id, engine: engineId, code: verdict.code });
        continue;
      case 'skip-has-workshop':
        counts.skipOk += 1;
        continue;
      case 'unmatched':
        if (unmatched.length < 50) unmatched.push({ id, engine: engineId, code: code.toLowerCase(), workshopId: verdict.workshopId });
        continue;
      default:
        break;
    }
    const label = verdict.action === 'fill' ? 'FILL' : verdict.action === 'normalize' ? 'NORM' : 'NAME';
    console.log(`  ${label} ${engineId} ${code.toLowerCase() || '?'} ${id} → «${verdict.workshopName}»`);
    if (args.apply) {
      const cur = await reload(id);
      if (!cur) continue;
      const rawMeta = rawMetaOf(cur);
      if (verdict.action === 'name-fill') rawMeta.workshopName = verdict.workshopName;
      else {
        rawMeta.workshopId = verdict.workshopId;
        rawMeta.workshopName = verdict.workshopName;
      }
      pending.push({
        type: 'upsert',
        table: SyncTableName.Operations,
        row_id: id,
        row: { ...toSyncRow(cur), meta_json: JSON.stringify(rawMeta), updated_at: ts, deleted_at: null, sync_status: 'synced' },
      });
    }
    if (verdict.action === 'fill') counts.fill += 1;
    else if (verdict.action === 'normalize') counts.normalize += 1;
    else counts.nameFill += 1;
    if (pending.length >= 500) await flush();
  }
  await flush();

  // Дефолты видов работ (вне синка — прямое UPDATE, журнал не нужен).
  const typeRows = (await pool.query(
    `SELECT code::text AS code, name::text AS name, workshop_id::text AS workshop_id FROM work_sheet_types WHERE archived_at IS NULL AND code IN ('sborka','obkatka')`,
  )) as { rows: Array<{ code: string; name: string; workshop_id: string | null }> };
  let typesSet = 0;
  const typesOdd: string[] = [];
  for (const t of typeRows.rows) {
    const want = byCode.get(RULE_BY_CODE[String(t.code ?? '').toLowerCase()] ?? '');
    const cur = String(t.workshop_id ?? '').trim();
    if (!want) continue;
    if (!cur) {
      console.log(`  TYPE-FILL вид «${t.name}» (${t.code}) → «${want.name}»`);
      if (args.apply) await pool.query(`UPDATE work_sheet_types SET workshop_id = $1 WHERE code = $2`, [want.id, t.code]);
      typesSet += 1;
    } else if (byId.get(cur.toLowerCase())) {
      // Дефолт уже стоит — ок.
    } else {
      typesOdd.push(`${t.code}=«${cur}»`);
    }
  }

  console.log(
    `\nИтог: проставить ${counts.fill}, нормализовать legacy ${counts.normalize}, ` +
      `добить имя ${counts.nameFill}, уже в порядке ${counts.skipOk}, ` +
      `без правила ${counts.skipRule}, не-этапов ${counts.skipStage}, ` +
      `у удалённых пропущено ${counts.skipDeleted}, дефолтов видов проставлено ${typesSet}.`,
  );
  if (noRule.length > 0) console.log(`Без правила (первые ${noRule.length}): ${noRule.map((r) => `${r.code}@${r.engine.slice(0, 8)}`).join(', ')}`);
  if (unmatched.length > 0) {
    console.log(`Неопознанный цех (${unmatched.length} — руками):`);
    for (const u of unmatched) console.log(`  ${u.engine} ${u.code} ${u.id} workshopId=«${u.workshopId}»`);
  }
  if (typesOdd.length > 0) console.log(`Чужие дефолты видов (руками): ${typesOdd.join(', ')}`);
}

const invokedDirectly = typeof process.argv[1] === 'string' && process.argv[1].endsWith('.ts');
if (invokedDirectly) {
  main()
    .catch((e: unknown) => {
      console.error(String((e as Error)?.message ?? e));
      process.exitCode = 2;
    })
    .finally(() => void pool.end().catch(() => {}));
}
