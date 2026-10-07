import 'dotenv/config';

import {
  moscowDayKey,
  parseRepairHistoryMeta,
  SyncTableName,
  SyncTableRegistry,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';
import { pr3CanonicalName } from './pr3StageNames.js';
import { camelOperationRowForSync } from './pr3SyncRow.js';

// stages:cleanup-duplicates — чистка копий этапов после перевода на новый формат
// (таблица этапов 05.10.2026; решение владельца 06.10.2026: «старые названия удалить,
// если это дубль, который сходится по датам с новым названием этапа»).
//
// Классы (дубль — только совпадение кода и МОСКОВСКОГО ДНЯ с новой строкой):
//   A. старая строка «этап работ» (meta.sheet: ukladka/sborka/obkatka) и новая строка
//      «этап ремонта» того же дня → старая мягко удаляется, человек-автор переносится
//      на живую: иначе в ленте остаётся автор «перенос этапов (скрипт)», а работа
//      человека теряется вместе со старой строкой;
//   C. старая «Приёмка ОТК» (priemka_otk) без пары → та же строка переписывается в
//      этап «Выходной контроль ОТК» (id/дата/автор сохраняются), дубль не заводится.
//      У двигателя уже есть ОТК другой датой — всё равно переводим: решение владельца
//      07.10.2026, две отметки ОТК на разные даты допустимы (реальный осмотр в один
//      день и повторный выходной контроль — разные события);
//   B. две строки «Приемка двигателя на завод» с разными датами (перенос 29.09 взял
//      дату карточки, 05.10 — дату акта; замер: у 53 движков карточка в первой строке,
//      у 7 — во второй) → остаётся строка с датой КАРТОЧКИ (канон владельца 06.10.2026),
//      лишняя мягко удаляется.
//
// Повторные проходы (pass ≥ 2), события разных дней (в т.ч. повторные «Утиль и брак»
// и «Сборка») и старые «стадии» не трогаются. Удаление — мягкое, через
// writeSyncChanges (журнал + seq): парк видит обычным pull.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:cleanup-duplicates            # dry-run
//   corepack pnpm -F @matricarmz/backend-api stages:cleanup-duplicates -- --apply
//   … -- --engine <uuid>   # один двигатель
//
// Удаление живых данных — гейт #025: --apply только после того, как владелец видел
// конкретный список из dry-run. Повторный прогон после apply обязан показать 0.
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:cleanup-duplicates', role: 'system' };

/** Старый код «этапа работ» → код этапа реестра. Прочие узлы (`val` и свои) этапами не были. */
export const SHEET_TWIN_STAGE_CODE: Readonly<Record<string, string>> = {
  ukladka: 'ukladka',
  sborka: 'sborka',
  obkatka: 'obkatka',
  priemka_otk: 'otk',
};

export function sheetTwinStageCode(code: string): string | null {
  return SHEET_TWIN_STAGE_CODE[String(code ?? '').trim().toLowerCase()] ?? null;
}

/** Индекс arrival-строки, чей московский день совпадает с датой карточки; null — нет совпадения. */
export function pickArrivalKeeper(days: ReadonlyArray<string>, cardDay: string | null): number | null {
  if (!cardDay) return null;
  const idx = days.indexOf(cardDay);
  return idx >= 0 ? idx : null;
}

function isServiceAuthor(name: unknown): boolean {
  const s = String(name ?? '').trim();
  return !s || s === 'local' || s.startsWith('stages:');
}

/** Новый автор живой строки: человек со старой, если у живой автор служебный; null — не менять. */
export function stageAuthorAfterMerge(stageBy: unknown, sheetBy: unknown): string | null {
  if (!isServiceAuthor(stageBy)) return null;
  const human = String(sheetBy ?? '').trim();
  if (!human || isServiceAuthor(human)) return null;
  return human;
}

/** Новое примечание живой строки: перенос со старой, если у живой пусто; null — не менять. */
export function stageNoteAfterMerge(stageNote: unknown, sheetNote: unknown): string | null {
  const cur = String(stageNote ?? '').trim();
  const add = String(sheetNote ?? '').trim();
  if (cur || !add) return null;
  return add;
}

/** Примечание старой строки «этап работ» → примечание этапа (первый сегмент — «Этап: …»). */
export function stageNoteFromSheetNote(note: unknown, stageName: string): string | null {
  const s = String(note ?? '').trim();
  if (!s) return null;
  const parts = s.split(' · ');
  if (parts[0]!.startsWith('Этап работ:')) {
    parts[0] = `Этап: ${stageName}`;
    return parts.join(' · ');
  }
  return null;
}

/** Дата из EAV `value_json`: число или `{kind:"date", value}`. */
export function parseEavDate(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  const s = String(raw ?? '').trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as { value?: unknown };
      const n = Number(obj?.value);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

type RawRow = Record<string, unknown>;

type StageLike = {
  id: string;
  engineId: string;
  code: string;
  day: string;
  at: number;
  pass: number;
  by: string;
  note: string;
  raw: RawRow;
};

function stageName(code: string): string {
  return pr3CanonicalName(code) ?? code;
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
  console.log(`stages:cleanup-duplicates — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const engineFilter = args.engine ? ' AND engine_entity_id = $1' : '';
  const params: unknown[] = args.engine ? [args.engine] : [];
  const found = (await pool.query(
    `SELECT * FROM operations
      WHERE operation_type = 'repair_history_entry' AND deleted_at IS NULL${engineFilter}`,
    params,
  )) as { rows: RawRow[] };

  const sheets: StageLike[] = [];
  const stages: StageLike[] = [];
  let skippedNoMeta = 0;
  for (const raw of found.rows) {
    const meta = parseRepairHistoryMeta(typeof raw.meta_json === 'string' ? raw.meta_json : null);
    const at = meta?.at != null && Number.isFinite(Number(meta.at)) ? Number(meta.at) : null;
    const pass = Number(meta?.repeat?.pass ?? 1);
    const base: StageLike = {
      id: String(raw.id),
      engineId: String(raw.engine_entity_id ?? ''),
      code: '',
      day: at != null ? moscowDayKey(at) : '',
      at: at ?? 0,
      pass: Number.isFinite(pass) && pass >= 1 ? Math.floor(pass) : 1,
      by: String(raw.performed_by ?? ''),
      note: String(meta?.note ?? ''),
      raw,
    };
    if (meta?.sheet && at != null && at > 0) {
      sheets.push({ ...base, code: String(meta.sheet.typeCode ?? '').trim().toLowerCase() });
    } else if (meta?.stage && at != null && at > 0) {
      stages.push({ ...base, code: String(meta.stage.code ?? '').trim().toLowerCase() });
    } else {
      skippedNoMeta += 1;
    }
  }

  const ts = Date.now();
  let pending: SyncWriteInput[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    if (args.apply) await writeSyncChanges(pending, ACTOR, { allowSyncConflicts: true });
    pending = [];
  };

  const twinByKey = new Map<string, StageLike>();
  for (const st of stages) twinByKey.set(`${st.engineId}|${st.code}|${st.day}`, st);
  const otkEngines = new Set(stages.filter((st) => st.code === 'otk').map((st) => st.engineId));

  let aDeleted = 0;
  let aSkippedRepeat = 0;
  let aSkippedNoTwin = 0;
  let cConverted = 0;
  console.log('\n== A/C. старые «этапы работ» ==');
  for (const sh of sheets.sort((a, b) => a.engineId.localeCompare(b.engineId) || a.day.localeCompare(b.day))) {
    const stageCode = sheetTwinStageCode(sh.code);
    if (!stageCode) {
      console.log(`  SKIP ${sh.engineId} ${sh.day} ${sh.code} — узел этапом не был (val и свои узлы)`);
      aSkippedNoTwin += 1;
      continue;
    }
    if (sh.pass >= 2) {
      aSkippedRepeat += 1;
      continue;
    }
    const twin = twinByKey.get(`${sh.engineId}|${stageCode}|${sh.day}`) ?? null;
    if (!twin) {
      if (stageCode !== 'otk') {
        console.log(`  SKIP ${sh.engineId} ${sh.day} ${sh.code} — пары в тот же день нет (не дубль)`);
        aSkippedNoTwin += 1;
        continue;
      }
      // ОТК уже есть другой датой — всё равно переводим (решение владельца 07.10.2026):
      // две отметки ОТК на разные даты — разные события, не дубль.
      console.log(
        `  CONVERT ${sh.engineId} ${sh.day} priemka_otk → otk (id/автор сохраняются${otkEngines.has(sh.engineId) ? '; у двигателя есть ОТК другой датой — будет вторая отметка' : ''})`,
      );
      if (args.apply) {
        const cur = await reload(sh.id);
        if (cur) {
          const rawMeta = rawMetaOf(cur);
          delete rawMeta.sheet;
          const name = stageName(stageCode);
          const oldNote = String(cur.note ?? '');
          const newNote = stageNoteFromSheetNote(oldNote, name) ?? oldNote;
          const nextMeta = JSON.stringify({
            ...rawMeta,
            action: name,
            entryType: 'stage',
            stage: { code: stageCode, name },
          });
          pending.push({
            type: 'upsert',
            table: SyncTableName.Operations,
            row_id: sh.id,
            row: { ...toSyncRow(cur), note: newNote, meta_json: nextMeta, updated_at: ts, deleted_at: null, sync_status: 'synced' },
          });
        }
      }
      cConverted += 1;
      if (pending.length >= 500) await flush();
      continue;
    }
    const nextAuthor = stageAuthorAfterMerge(twin.by, sh.by);
    const nextNote = stageNoteAfterMerge(twin.note, sh.note);
    console.log(
      `  DUPLICATE ${sh.engineId} ${sh.day} ${sh.code} → ${stageCode}: удаляю ${sh.id}, живая ${twin.id}` +
        `${nextAuthor ? `, автор → ${nextAuthor}` : ''}${nextNote ? `, примечание → «${nextNote}»` : ''}`,
    );
    if (args.apply) {
      if (nextAuthor || nextNote) {
        const cur = await reload(twin.id);
        if (cur) {
          const rawMeta = rawMetaOf(cur);
          pending.push({
            type: 'upsert',
            table: SyncTableName.Operations,
            row_id: twin.id,
            row: {
              ...toSyncRow(cur),
              ...(nextAuthor ? { performed_by: nextAuthor } : {}),
              meta_json: JSON.stringify({ ...rawMeta, ...(nextNote ? { note: nextNote } : {}) }),
              updated_at: ts,
              deleted_at: null,
              sync_status: 'synced',
            },
          });
        }
      }
      const curSheet = await reload(sh.id);
      if (curSheet) {
        pending.push({
          type: 'delete',
          table: SyncTableName.Operations,
          row_id: sh.id,
          row: { ...toSyncRow(curSheet), updated_at: ts, deleted_at: ts, sync_status: 'synced' },
        });
      }
    }
    aDeleted += 1;
    if (pending.length >= 500) await flush();
  }

  console.log('\n== B. «Приемка двигателя на завод» двумя строками ==');
  const byEngine = new Map<string, StageLike[]>();
  for (const st of stages) {
    if (st.code !== 'arrival' || st.pass >= 2) continue;
    const arr = byEngine.get(st.engineId) ?? [];
    arr.push(st);
    byEngine.set(st.engineId, arr);
  }
  const twinEngines = [...byEngine.entries()].filter(([, arr]) => arr.length > 1).sort((a, b) => a[0].localeCompare(b[0]));
  const cardByEngine = new Map<string, string>();
  if (twinEngines.length > 0) {
    const eav = (await pool.query(
      `SELECT av.entity_id::text AS engine_id, av.value_json
         FROM attribute_values av JOIN attribute_defs ad ON ad.id = av.attribute_def_id
        WHERE ad.code = 'arrival_date' AND av.deleted_at IS NULL AND av.entity_id = ANY($1)`,
      [twinEngines.map(([engineId]) => engineId)],
    )) as { rows: Array<{ engine_id: string; value_json: unknown }> };
    for (const r of eav.rows) {
      const at = parseEavDate(r.value_json);
      if (at != null) cardByEngine.set(String(r.engine_id), moscowDayKey(at));
    }
  }
  let bDeleted = 0;
  let bSkipped = 0;
  for (const [engineId, arr] of twinEngines) {
    const ordered = [...arr].sort((a, b) => a.at - b.at);
    const keeperIdx = pickArrivalKeeper(ordered.map((r) => r.day), cardByEngine.get(engineId) ?? null);
    if (keeperIdx === null) {
      console.log(`  SKIP ${engineId} — дата карточки не найдена или не совпала ни с одной строкой (${ordered.map((r) => r.day).join(', ')})`);
      bSkipped += 1;
      continue;
    }
    const keeper = ordered[keeperIdx]!;
    const victims = ordered.filter((r) => r.id !== keeper.id);
    console.log(
      `  DUPLICATE ${engineId}: живая ${keeper.id} (${keeper.day} = дата карточки), удаляю ${victims.map((v) => `${v.id} (${v.day})`).join(', ')}`,
    );
    if (args.apply) {
      let nextAuthor = keeper.by;
      for (const v of victims) {
        const moved = stageAuthorAfterMerge(nextAuthor, v.by);
        if (moved) nextAuthor = moved;
      }
      if (nextAuthor !== keeper.by) {
        const cur = await reload(keeper.id);
        if (cur) {
          pending.push({
            type: 'upsert',
            table: SyncTableName.Operations,
            row_id: keeper.id,
            row: { ...toSyncRow(cur), performed_by: nextAuthor, updated_at: ts, deleted_at: null, sync_status: 'synced' },
          });
        }
      }
      for (const v of victims) {
        const cur = await reload(v.id);
        if (!cur) continue;
        pending.push({
          type: 'delete',
          table: SyncTableName.Operations,
          row_id: v.id,
          row: { ...toSyncRow(cur), updated_at: ts, deleted_at: ts, sync_status: 'synced' },
        });
      }
    }
    bDeleted += victims.length;
    if (pending.length >= 500) await flush();
  }
  await flush();

  console.log(
    `\nкласс A: удалено старых ${aDeleted}, пропущено повторов ${aSkippedRepeat}, без пары/вне карты ${aSkippedNoTwin}`,
  );
  console.log(`класс C: переведено в «Выходной контроль ОТК» ${cConverted}`);
  console.log(`класс B: удалено лишних «Приемка» ${bDeleted}, пропущено без даты карточки ${bSkipped}`);
  console.log(`пропущено без мета: ${skippedNoMeta}`);
  if (!args.apply) console.log('Без --apply запись не выполняется.');
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
