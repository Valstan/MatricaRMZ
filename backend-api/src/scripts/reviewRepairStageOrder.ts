import 'dotenv/config';

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPAIR_HISTORY_OPERATION_TYPE, SyncTableName, SyncTableRegistry } from '@matricarmz/shared';
import { and, eq } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { operations } from '../database/schema.js';
import { writeSyncChanges, type SyncWriteActor, type SyncWriteInput } from '../services/sync/syncWriteService.js';

// stages:review-order — разбор «поздний этап стоит раньше дефектовки» (GOTCHAS M146, жалоба
// владельца 30.09.2026) и применение РЕШЕНИЯ владельца по этим строкам.
//
// Инструмент не решает, что́ верно: он показывает обе стороны (строка этапа ↔ атрибут
// карточки, откуда бэкфилл `stages:backfill` её взял) и применяет только то, что владелец
// вписал в файл решений. Поэтому три режима: отчёт, `--emit` (шаблон решений), `--apply`.
//
// Почему у решения две мишени (`stage` и `card`): строки этапов у этих двигателей — точные
// копии `status_customer_sent_date` / `status_customer_accepted_date` карточки. Правка одной
// строки этапа оставила бы карточку старой, и расхождение вернулось бы при следующем
// переносе. Решение владельца может быть любым их сочетанием — или ни одним.
//
// Защита от выдумывания: каждое решение несёт `expect_*` — то, что было на экране при
// разборе. Расхождение с текущим состоянием = отказ поимённо, а не «применить поверх».
// Тот же класс, что защита «сносим только сироты, расходящиеся оставляем стоять» в
// `engine-inventory:dedup-sheets` (#1061): решение принимается по совпадению, не по «похоже».
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api stages:review-order
//   … stages:review-order -- --engine <uuid|№ двигателя>
//   … stages:review-order -- --emit verdicts.json
//   … stages:review-order -- --decisions verdicts.json --apply
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка (в т.ч. хотя бы одно решение разошлось с данными).

const DEFECT_STAGE_CODE = 'disassembly_defect';

/** Коды этапов, которые по смыслу идут ПОЗЖЕ дефектовки (те же, что в fixDefectStageDates). */
const LATER_STAGE_CODES = ['obkatka', 'sborka', 'otk', 'shipped', 'accepted'] as const;

/**
 * Атрибут карточки, из которого бэкфилл `stages:backfill` взял дату этапа (его
 * `STATUS_TO_STAGE` + EAV `arrival_date`/`defect_date`). Пустая строка — источника нет:
 * ремонтные этапы приходили из строк ведомостей, а не с карточки.
 */
const CARD_SOURCE_ATTR: Record<string, string> = {
  disassembly_defect: 'defect_date',
  arrival: 'arrival_date',
  shipped: 'status_customer_sent_date',
  accepted: 'status_customer_accepted_date',
  repaired: 'status_repaired_date',
  kitting_done: '',
  obkatka: '',
  sborka: '',
  otk: '',
};

/**
 * Мишени `card` ограничены датами, из которых берутся этапы: иначе инструмент был бы
 * общим редактором EAV на проде.
 */
const ALLOWED_CARD_ATTRS = new Set<string>([
  'defect_date',
  'arrival_date',
  'status_customer_sent_date',
  'status_customer_accepted_date',
  'status_repaired_date',
]);

const CARD_ATTR_CODES = ['engine_number', 'engine_brand', ...ALLOWED_CARD_ATTRS, 'shipping_date'];

const KNOWN_ACTIONS = new Set<NonNullable<StageOrderDecision['action']>>(['set-date', 'clear-date', 'delete-row']);

const ACTOR: SyncWriteActor = { id: 'server', username: 'stages:review-order', role: 'system' };

// ────────────────────────────────────────────────────────────
// Решение владельца и его проверка (чистые функции — их и тестируем)
// ────────────────────────────────────────────────────────────

export type StageOrderDecision = {
  target: 'stage' | 'card';
  engine_number: string;
  engine_id: string;
  /** Мишень `stage`: id строки истории. */
  row_id?: string;
  stage_code?: string;
  /** Мишень `card`: код атрибута. */
  attribute_code?: string;
  /** Дата, которую видели при разборе: `meta.at` строки либо значение атрибута карточки. */
  expect_at?: number | null;
  /** Дата дефектовки на момент разбора — решение «про порядок» без неё недействительно. */
  expect_defect_at?: number;
  action: 'set-date' | 'clear-date' | 'delete-row' | null;
  /** Новая дата (мс) для `set-date`. */
  at?: number;
  /** Явное «я знаю, что новая дата всё ещё раньше дефектовки». */
  allow_out_of_order?: boolean;
  /** Справочное: атрибут, из которого строка скопирована. На решение не влияет. */
  card_source_attr?: string;
};

/** Состояние цели решения, перечитанное из БД в момент apply. */
export type DecisionTargetState = {
  exists: boolean;
  engineId: string;
  engineNumber: string;
  stageCode: string | null;
  at: number | null;
  defectAt: number | null;
  /** Строка этапа не была помечена конфликтной при разборе — её решение не может быть применено. */
  inConflict: boolean;
};

export type DecisionCheck =
  | { ok: true; action: NonNullable<StageOrderDecision['action']>; at: number | null }
  | { ok: false; reason: string };

/**
 * Единственное место, где решение превращается в действие. Здесь вся безопасность прохода:
 * решение принимается по совпадению с тем, что владелец видел, а не по «похоже на список».
 */
export function evaluateDecision(decision: StageOrderDecision, state: DecisionTargetState): DecisionCheck {
  if (decision.action == null) return { ok: false, reason: 'no_verdict' };
  // Неизвестное действие обязано отказать, а не провалиться в ветку set-date: файл решений
  // пишет владелец руками, и опечатка в `action` иначе стала бы записью `at: null`.
  if (!KNOWN_ACTIONS.has(decision.action)) return { ok: false, reason: 'unknown_action' };
  if (decision.target === 'stage') {
    if (decision.action === 'clear-date') return { ok: false, reason: 'action_target_mismatch' };
    if (!decision.row_id || !decision.stage_code) return { ok: false, reason: 'incomplete_decision' };
  } else {
    if (decision.action === 'delete-row') return { ok: false, reason: 'action_target_mismatch' };
    if (!decision.attribute_code) return { ok: false, reason: 'incomplete_decision' };
    if (!ALLOWED_CARD_ATTRS.has(decision.attribute_code)) return { ok: false, reason: 'attr_not_allowed' };
  }
  if (decision.action === 'set-date' && !Number.isFinite(decision.at)) return { ok: false, reason: 'bad_new_date' };
  if (!state.exists) return { ok: false, reason: 'target_missing' };
  if (state.engineId !== decision.engine_id || state.engineNumber !== decision.engine_number) {
    return { ok: false, reason: 'engine_mismatch' };
  }
  if (decision.target === 'stage') {
    if (!state.inConflict) return { ok: false, reason: 'row_not_in_conflict' };
    if (state.stageCode !== decision.stage_code) return { ok: false, reason: 'stage_code_changed' };
    if ((state.at ?? null) !== (decision.expect_at ?? null)) return { ok: false, reason: 'date_changed' };
    if (decision.action === 'delete-row' && state.stageCode === DEFECT_STAGE_CODE) {
      return { ok: false, reason: 'defect_stage_protected' };
    }
  } else if ((state.at ?? null) !== (decision.expect_at ?? null)) {
    return { ok: false, reason: 'attr_changed' };
  }
  if ((state.defectAt ?? null) !== (decision.expect_defect_at ?? null)) return { ok: false, reason: 'defect_date_moved' };
  if (
    decision.action === 'set-date' &&
    state.defectAt != null &&
    (decision.at ?? 0) < state.defectAt &&
    !decision.allow_out_of_order
  ) {
    return { ok: false, reason: 'out_of_order_without_ack' };
  }
  return { ok: true, action: decision.action, at: decision.action === 'set-date' ? (decision.at ?? null) : null };
}

/** Отметка для отчёта: строка этапа — копия даты статуса карточки. */
export function cardSourceOf(
  stageCode: string,
  rowAt: number | null,
  cardDates: Record<string, number | null>,
): { attr: string; exact: boolean } | null {
  const attr = CARD_SOURCE_ATTR[stageCode] ?? '';
  if (!attr) return null;
  const cardAt = cardDates[attr] ?? null;
  if (cardAt == null || rowAt == null) return { attr, exact: false };
  return { attr, exact: cardAt === rowAt };
}

// ────────────────────────────────────────────────────────────
// Чтение состояния
// ────────────────────────────────────────────────────────────

type StageRow = {
  id: string;
  engine_id: string;
  at: number | null;
  code: string;
  name: string;
  pass: number | null;
  engine_number: string;
  brand: string;
  card: Record<string, string | null>;
};

type Snapshot = { defectAt: Map<string, number>; rows: StageRow[] };

function dayKey(ms: number | null): string {
  return ms == null ? '—'.padEnd(10) : new Date(ms).toISOString().slice(0, 10);
}

/**
 * Живые строки этапов + атрибуты карточки. По умолчанию — только двигатели, у которых
 * поздний этап оказался раньше дефектовки (режим разбора); `engineIds` вместо этого берёт
 * ровно перечисленные двигатели, что нужно apply-проходу: после чужой правки двигатель из
 * разбора выпадает, и отказ пришёл бы как «строка потеряна» вместо «решение устарело».
 * Один SQL: два прохода по истории разъехались бы по времени, и отчёт напечатал бы
 * несуществующее расхождение.
 */
async function loadStageSnapshot(opts: { engineFilter?: string | null; engineIds?: string[] | null } = {}): Promise<Snapshot> {
  const engineIds = opts.engineIds ?? null;
  const params: unknown[] = [REPAIR_HISTORY_OPERATION_TYPE];
  let filter = '';
  let scope = '';
  if (engineIds) {
    params.push(engineIds);
    scope = `scope as (select unnest($2::uuid[])::text as eng)`;
  } else {
    if (opts.engineFilter) {
      params.push(opts.engineFilter);
      filter = /^[0-9a-f-]{36}$/i.test(opts.engineFilter)
        ? 'and o.engine_entity_id::text = $2'
        : // Номер двигателя — это EAV, а не колонка: ищем по атрибуту, иначе фильтр «похож»
          // молча ничего не сузит и разбор покажет чужие двигатели.
          `and exists (select 1 from attribute_defs ad3
                         join attribute_values av3 on av3.attribute_def_id = ad3.id and av3.deleted_at is null
                        where av3.entity_id = o.engine_entity_id
                          and ad3.code = 'engine_number'
                          and trim(both '"' from av3.value_json) = $2)`;
    }
    scope = `scope as (
      select d.eng, d.defect_at
        from defect d
        join st later on later.eng = d.eng
                       and later.code in ('${LATER_STAGE_CODES.join("','")}')
                       and later.at is not null
                       and later.at < d.defect_at
       group by d.eng, d.defect_at
    )`;
  }

  const sql = `
    with st as (
      select o.id::text as id,
             o.engine_entity_id::text as eng,
             coalesce(nullif(o.meta_json::jsonb->>'at', '')::bigint, o.performed_at) as at,
             o.meta_json::jsonb->'stage'->>'code' as code,
             coalesce(o.meta_json::jsonb->'stage'->>'name', '') as sname,
             nullif(o.meta_json::jsonb->'repeat'->>'pass', '')::int as pass
        from operations o
       where o.operation_type = $1
         and o.deleted_at is null
         and o.meta_json is not null
         and o.meta_json::jsonb->'stage'->>'code' is not null
         ${filter}
    ),
    defect as (
      select eng, min(at) as defect_at
        from st
       where code = '${DEFECT_STAGE_CODE}' and at is not null and coalesce(pass, 1) < 2
       group by eng
    ),
    ${scope}
    select st.id, st.eng as engine_id, st.at, st.code, st.sname as name, st.pass,
           coalesce(attrs.a->>'engine_number', '') as engine_number,
           coalesce(attrs.a->>'engine_brand', '') as brand,
           coalesce(attrs.a, '{}'::jsonb) as card
      from st
      join scope on scope.eng = st.eng
      left join lateral (
        -- Привязка av.entity_id = st.eng обязательна рядом с привязкой к типу: без неё агрегат
        -- сворачивал значения ВСЕХ двигателей этого типа, и карточка в отчёте досталась бы
        -- чужому двигателю (ловится только на данных, где их больше одного).
        select jsonb_object_agg(ad.code, nullif(trim(both '"' from av.value_json), '')) as a
          from attribute_defs ad
          join attribute_values av on av.attribute_def_id = ad.id
               and av.entity_id = st.eng::uuid
               and av.deleted_at is null
         where ad.entity_type_id = (select type_id from entities where id = st.eng::uuid)
           and ad.deleted_at is null
           and ad.code in ('${CARD_ATTR_CODES.join("','")}')
      ) attrs on true
     order by st.at
  `;
  const result = (await pool.query(sql, params)) as { rows: StageRow[] };
  const defectAt = new Map<string, number>();
  // pg отдаёт bigint (в т.ч. `at`) СТРОКОЙ: без приведения `new Date("1756051200000")`
  // бросает Invalid time value, а сравнение дат уезжает на лексикографику.
  const rows: StageRow[] = result.rows.map((r) => ({ ...r, at: numOrNull(r.at) }));
  for (const r of rows) {
    if (r.code === DEFECT_STAGE_CODE && r.at != null && !defectAt.has(r.engine_id)) defectAt.set(r.engine_id, r.at);
  }
  return { defectAt, rows };
}

function numOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function groupByEngine(rows: StageRow[]): Map<string, StageRow[]> {
  const byEngine = new Map<string, StageRow[]>();
  for (const r of rows) {
    const arr = byEngine.get(r.engine_id) ?? [];
    arr.push(r);
    byEngine.set(r.engine_id, arr);
  }
  for (const arr of byEngine.values()) arr.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return byEngine;
}

function cardDatesOf(row: StageRow): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [code, value] of Object.entries(row.card ?? {})) out[code] = numOrNull(value);
  return out;
}

function printReport(snap: Snapshot): void {
  const byEngine = groupByEngine(snap.rows);
  console.log(`двигателей в разборе: ${byEngine.size}\n`);
  for (const [engineId, list] of byEngine) {
    const head = list[0]!;
    const defectAt = snap.defectAt.get(engineId) ?? null;
    const cardDates = cardDatesOf(head);
    console.log(`${head.engine_number || '(без номера)'} · ${head.brand || '—'} · дефектовка ${dayKey(defectAt)}`);
    for (const r of list) {
      const src = cardSourceOf(r.code, r.at, cardDates);
      const tail = src
        ? `   ← карточка ${src.attr}${src.exact ? ' (точная копия)' : ` = ${dayKey(cardDates[src.attr] ?? null)}`}`
        : '';
      const pass = r.pass && r.pass > 1 ? ` (проход ${r.pass})` : '';
      console.log(`  ${dayKey(r.at)}  ${r.code.padEnd(19)} ${r.name}${pass}${tail}`);
      if (defectAt != null && r.at != null && r.at < defectAt && r.code !== DEFECT_STAGE_CODE) {
        console.log(`  ${' '.repeat(12)}⚠ раньше дефектовки — предмет решения владельца`);
      }
    }
    const card = Object.entries(cardDates)
      .filter(([, v]) => v != null)
      .map(([code, v]) => `${code}=${dayKey(v)}`)
      .join(' ');
    console.log(`  карточка: ${card || '(дат нет)'}\n`);
  }
}

/** Шаблон файла решений: все `expect_*` заполнены, `action` — пусто (решение владельца). */
function buildTemplate(snap: Snapshot): unknown {
  const decisions: StageOrderDecision[] = [];
  for (const [engineId, list] of groupByEngine(snap.rows)) {
    const head = list[0]!;
    const defectAt = snap.defectAt.get(engineId) ?? null;
    const cardDates = cardDatesOf(head);
    for (const r of list) {
      if (r.code === DEFECT_STAGE_CODE || defectAt == null || r.at == null || r.at >= defectAt) continue;
      const src = cardSourceOf(r.code, r.at, cardDates);
      decisions.push({
        target: 'stage',
        engine_number: head.engine_number,
        engine_id: engineId,
        row_id: r.id,
        stage_code: r.code,
        expect_at: r.at,
        expect_defect_at: defectAt,
        action: null,
        ...(src?.exact ? { card_source_attr: src.attr } : {}),
      });
      // Мишень `card` — того же двигателя и того же атрибута: строка была его копией, значит
      // решение «строка верна, карточка нет» и «обе неверны» выглядят в файле одинаково.
      if (src?.exact) {
        decisions.push({
          target: 'card',
          engine_number: head.engine_number,
          engine_id: engineId,
          attribute_code: src.attr,
          expect_at: cardDates[src.attr] ?? null,
          expect_defect_at: defectAt,
          action: null,
        });
      }
    }
  }
  return {
    generated_by: 'stages:review-order',
    how_to_use: [
      'action: "set-date" (+ at в мс) | "clear-date" (только для card) | "delete-row" (только для stage) | null — решение не принято.',
      'Дату из DD.MM.YYYY перевести в мс: node -e "console.log(Date.parse(\'2026-03-11\'))".',
      'Новая дата, остающаяся раньше дефектовки, требует allow_out_of_order: true — иначе отказ out_of_order_without_ack.',
      'expect_* — то, что было на экране при разборе. Расхождение с текущим состоянием = отказ поимённо, перезапустите разбор.',
      'Строка этапа и атрибут карточки — два решения: оставьте action: null там, где правки не нужно.',
    ],
    decisions,
  };
}

// ────────────────────────────────────────────────────────────
// Apply
// ────────────────────────────────────────────────────────────

function stateFor(decision: StageOrderDecision, snap: Snapshot): DecisionTargetState {
  const list = groupByEngine(snap.rows).get(decision.engine_id) ?? [];
  const head = list[0];
  const defectAt = snap.defectAt.get(decision.engine_id) ?? null;
  if (decision.target === 'card') {
    const card = cardDatesOf(head ?? ({ card: {} } as StageRow));
    return {
      exists: head != null,
      engineId: decision.engine_id,
      // `||`, а не `??`: пустой номер двигателя — это тоже отсутствие номера, и сверять его с
      // записанным в решении нельзя (иначе движок без номера стал бы неприменимым вовсе).
      engineNumber: head?.engine_number || decision.engine_number,
      stageCode: null,
      at: card[decision.attribute_code ?? ''] ?? null,
      defectAt,
      inConflict: true,
    };
  }
  const row = list.find((r) => r.id === decision.row_id) ?? null;
  return {
    exists: row != null,
    engineId: decision.engine_id,
    engineNumber: head?.engine_number || decision.engine_number,
    stageCode: row?.code ?? null,
    at: row?.at ?? null,
    defectAt,
    inConflict: defectAt != null && row?.at != null && row.at < defectAt,
  };
}

async function stageInput(d: StageOrderDecision, check: Extract<DecisionCheck, { ok: true }>): Promise<SyncWriteInput> {
  const found = await db.select().from(operations).where(and(eq(operations.id, d.row_id as never))).limit(1);
  const row = found[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error(`строка ${d.row_id} не найдена — решение устарело`);
  const ts = Date.now();
  const dto = SyncTableRegistry.toSyncRow(SyncTableName.Operations, row as never) as Record<string, unknown>;
  if (check.action === 'delete-row') {
    return {
      type: 'delete',
      table: SyncTableName.Operations,
      row_id: String(dto.id ?? d.row_id),
      row: { ...dto, updated_at: ts, deleted_at: ts, sync_status: 'synced' },
    };
  }
  // Меняется ровно `at`: остальные ключи meta (повтор, отметки, примечание) не трогаются, и
  // `performed_at` двигается вместе с ним — иначе отчёты по трудозатратам уедут в сторону.
  const meta = JSON.parse(String(dto.meta_json ?? '{}')) as Record<string, unknown>;
  return {
    type: 'upsert',
    table: SyncTableName.Operations,
    row_id: String(dto.id ?? d.row_id),
    row: {
      ...dto,
      meta_json: JSON.stringify({ ...meta, at: check.at }),
      performed_at: check.at,
      updated_at: ts,
      deleted_at: null,
      sync_status: 'synced',
    },
  };
}

async function cardInput(d: StageOrderDecision, check: Extract<DecisionCheck, { ok: true }>): Promise<SyncWriteInput> {
  const found = (await pool.query(
    `select av.id::text as id, ad.id::text as def_id, av.created_at
       from entities e
       join attribute_defs ad on ad.entity_type_id = e.type_id and ad.code = $2 and ad.deleted_at is null
       join attribute_values av on av.attribute_def_id = ad.id and av.entity_id = e.id and av.deleted_at is null
      where e.id = $1`,
    [d.engine_id, d.attribute_code],
  )) as { rows: Array<{ id: string; def_id: string; created_at: number }> };
  const row = found.rows[0];
  if (!row) throw new Error(`у двигателя нет атрибута ${d.attribute_code} — решение устарело`);
  return {
    type: 'upsert',
    table: SyncTableName.AttributeValues,
    row_id: row.id,
    row: {
      id: row.id,
      entity_id: d.engine_id,
      attribute_def_id: row.def_id,
      // Очистка — это SQL NULL, а не строка "null": строка проходит zod (`value_json` строка),
      // а потом ломает любое приведение к дате (ловил на своём же разборе).
      value_json: check.action === 'clear-date' ? null : JSON.stringify(check.at),
      created_at: Number(row.created_at),
      updated_at: Date.now(),
      deleted_at: null,
      sync_status: 'synced',
    },
  };
}

function parseArgs(argv: string[]): { apply: boolean; engine: string | null; emit: string | null; decisions: string | null } {
  const out = { apply: false, engine: null as string | null, emit: null as string | null, decisions: null as string | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--engine') out.engine = String(argv[++i] ?? '').trim() || null;
    else if (a === '--emit') out.emit = String(argv[++i] ?? '').trim() || null;
    else if (a === '--decisions') out.decisions = String(argv[++i] ?? '').trim() || null;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

async function applyDecisions(path: string): Promise<void> {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as { decisions?: unknown };
  if (!Array.isArray(raw.decisions)) throw new Error('файл решений: нет массива decisions');
  const decisions = raw.decisions as StageOrderDecision[];
  // Снимок по перечисленным двигателям, а не по разбору: решение, принято по экрану, обязано
  // сверяться с тем, что в данных СЕЙЧАС, — иначе уже применённая правка выглядит как
  // «двигатель исчез из разбора».
  const engineIds = [...new Set(decisions.map((d) => d.engine_id))];
  const snap = await loadStageSnapshot({ engineIds });
  let applied = 0;
  const skipped: string[] = [];
  for (const d of decisions) {
    const label = `${d.engine_number} ${d.stage_code ?? d.attribute_code ?? ''}`;
    const check = evaluateDecision(d, stateFor(d, snap));
    if (!check.ok) {
      skipped.push(`${label}: ${check.reason}`);
      continue;
    }
    const input = d.target === 'stage' ? await stageInput(d, check) : await cardInput(d, check);
    const res = await writeSyncChanges([input], ACTOR, { allowSyncConflicts: true });
    applied += 1;
    console.log(`  ✓ ${label}: ${check.action}${check.at != null ? ` → ${dayKey(check.at)}` : ''} (seq ${res.lastSeq})`);
  }
  console.log(`\nприменено: ${applied}, отказано: ${skipped.length}`);
  for (const s of skipped) console.log(`  ! ${s}`);
  const after = await loadStageSnapshot();
  console.log(
    after.rows.length === 0
      ? 'повторный разбор: конфликтов нет'
      : `повторный разбор: осталось строк в разборе ${after.rows.length} — перезапустите разбор и решите заново`,
  );
  if (skipped.length > 0) process.exitCode = 2;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`stages:review-order — ${args.apply ? 'ЗАПИСЬ по решениям владельца' : 'разбор, ничего не меняет'}`);

  if (args.decisions) {
    if (!args.apply) {
      const raw = JSON.parse(readFileSync(resolve(args.decisions), 'utf8')) as { decisions?: unknown };
      console.log(`файл решений: ${args.decisions} (${Array.isArray(raw.decisions) ? raw.decisions.length : 0} решений). Без --apply запись не выполняется.`);
      return;
    }
    await applyDecisions(args.decisions);
    return;
  }

  const snap = await loadStageSnapshot({ engineFilter: args.engine });
  if (snap.rows.length === 0) {
    console.log('Ни одного двигателя с поздним этапом раньше дефектовки — разбирать нечего.');
    return;
  }
  printReport(snap);
  if (args.emit) {
    writeFileSync(resolve(args.emit), `${JSON.stringify(buildTemplate(snap), null, 2)}\n`, 'utf8');
    console.log(`шаблон решений: ${args.emit} — вписать action/at, затем --decisions … --apply`);
  }
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  try {
    return realpathSync(resolve(argv)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main()
    .catch((e) => {
      console.error(String((e as Error)?.message ?? e));
      process.exitCode = 2;
    })
    .finally(() => void pool.end().catch(() => {}));
}
