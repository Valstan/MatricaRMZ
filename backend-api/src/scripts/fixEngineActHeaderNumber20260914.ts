/**
 * One-off проход по базе: вернуть в шапку листа `engine_inventory` значения из карточки
 * двигателя — номер, марку и внутренний номер.
 *
 * Что случилось. Автоподстановка шапки запоминала владение полем в момент ЗАПИСИ, а запись не
 * всегда закреплялась: brand-resync сохранял лист со своим, более старым снимком `answers` и
 * возвращал шапку пустой. Следующий проход читал «поле пустое, а писали его мы» как «оператор
 * стёр руками» и больше не писал никогда — значение замирало на том фрагменте, что был в полёте
 * (у номера — обычно на первой букве). Механика починена в клиенте (PR #898), но уже записанные
 * листы сами не исправятся: подстановка не трогает непустое значение.
 *
 * Что делает скрипт — правит ТОЛЬКО явные следы этого дефекта:
 *   * поле пусто, а в карточке значение есть → ставим значение;
 *   * в поле строгий ПРЕФИКС значения из карточки («2» при «2Ж03АТ») → дописываем целиком.
 * Любое другое расхождение — это то, что оператор вписал руками, и оно неприкосновенно.
 * Регистр и пробелы по краям при сравнении не учитываются, иначе «2ж» не опознается префиксом.
 *
 * ⚠ Внутренний номер собирается ТОЛЬКО из сохранённого года. Карточка, когда года нет,
 * подставляет текущий — для листа трёхлетней давности это записало бы год, которого в данных
 * никогда не было. Такой лист получает голый номер («41»), ровно как его видит сервер.
 *
 * Печать от этого не менялась: печатная форма берёт значения из карточки двигателя, а из шапки —
 * только когда в карточке пусто. То есть акты печатались верно и до прохода; чинится то, что
 * оператор видит на экране и что уезжает в историю версий акта.
 *
 * Запись идёт штатным sync-путём (`writeSyncChanges`) — прямой UPDATE оставил бы
 * `last_server_seq = NULL`, и правка не доехала бы клиентам инкрементальным pull'ом (GOTCHAS M6).
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply              — выполнить запись
 *   --fields=a,b         — только эти поля (engine_number, engine_brand, engine_internal_number)
 *   --actor=<username>   — актор (по умолчанию: первый superadmin)
 *   --limit=<N>          — обработать не больше N листов (для пробного прогона на проде)
 *
 *   pnpm -F @matricarmz/backend-api engine-act:fix-header-number          # dry-run
 *   pnpm -F @matricarmz/backend-api engine-act:fix-header-number --apply
 */
import 'dotenv/config';

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENGINE_INTERNAL_NUMBER_CODE,
  ENGINE_INTERNAL_NUMBER_YEAR_CODE,
  formatEngineInternalNumber,
  isValidEngineInternalNumberYear,
  SyncTableName,
} from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(0, Math.trunc(Number(limitArg.split('=')[1]))) : 0;
const fieldsArg = process.argv.find((a) => a.startsWith('--fields='));

/**
 * Поля шапки, которые умеет чинить проход. Все три обнулял один и тот же механизм, и правило
 * для них общее — различается только то, откуда берётся эталон из карточки двигателя.
 */
const HEADER_FIELDS = ['engine_number', 'engine_brand', 'engine_internal_number'] as const;
type HeaderField = (typeof HEADER_FIELDS)[number];
const FIELD_TITLE: Record<HeaderField, string> = {
  engine_number: '№ двигателя',
  engine_brand: 'марка',
  engine_internal_number: 'внутренний №',
};
const FIELDS: HeaderField[] = fieldsArg
  ? fieldsArg
      .split('=')[1]!
      .split(',')
      .map((f) => f.trim())
      .filter((f): f is HeaderField => (HEADER_FIELDS as readonly string[]).includes(f))
  : [...HEADER_FIELDS];
if (FIELDS.length === 0) throw new Error(`--fields: допустимы ${HEADER_FIELDS.join(', ')}`);

type Actor = { id: string; username: string; role: string };

const norm = (v: unknown) => String(v ?? '').trim();
const key = (v: unknown) => norm(v).toLowerCase();

async function resolveActor(): Promise<Actor> {
  const r = await pool.query(
    `select e.id::text as id, trim(both '"' from lg.value_json) as username
       from entities e
       join entity_types t on t.id = e.type_id and t.code = 'employee'
       join attribute_defs sd on sd.entity_type_id = t.id and sd.code = 'system_role' and sd.deleted_at is null
       join attribute_values sr on sr.entity_id = e.id and sr.attribute_def_id = sd.id and sr.deleted_at is null
            and trim(both '"' from sr.value_json) = 'superadmin'
       join attribute_defs ld on ld.entity_type_id = t.id and ld.code = 'login' and ld.deleted_at is null
       left join attribute_values lg on lg.entity_id = e.id and lg.attribute_def_id = ld.id and lg.deleted_at is null
      where e.deleted_at is null
      order by username`,
  );
  if (r.rows.length === 0) throw new Error('не найдено ни одного superadmin — передайте --actor=<username>');
  const pick = ACTOR_OVERRIDE
    ? r.rows.find((x: { username: string }) => String(x.username) === ACTOR_OVERRIDE)
    : r.rows[0];
  if (!pick) throw new Error(`--actor=${ACTOR_OVERRIDE}: такой superadmin не найден`);
  return { id: String(pick.id), username: String(pick.username), role: 'superadmin' };
}

/** Текстовый ответ шапки; отсутствующий пункт и не-text считаем пустым. */
function readHeader(answers: unknown, id: string): string {
  const a = (answers as Record<string, unknown> | null | undefined)?.[id] as
    | { kind?: unknown; value?: unknown }
    | undefined;
  if (!a || a.kind !== 'text') return '';
  return norm(a.value);
}

/**
 * Решение по одному листу. Отдельная чистая функция: ровно она определяет, что считается
 * следом дефекта, а что — работой оператора.
 */
export function decideHeaderFix(args: {
  stored: string;
  card: string;
}): { action: 'fill' | 'extend' | 'skip'; reason: string } {
  const card = norm(args.card);
  const stored = norm(args.stored);
  if (!card) return { action: 'skip', reason: 'в карточке пусто' };
  if (key(stored) === key(card)) return { action: 'skip', reason: 'уже совпадает' };
  if (!stored) return { action: 'fill', reason: 'поле пусто' };
  if (key(card).startsWith(key(stored))) return { action: 'extend', reason: `обрезано до «${stored}»` };
  return { action: 'skip', reason: `в шапке своё значение «${stored}»` };
}

async function main() {
  const actor = await resolveActor();
  console.log(`актор: ${actor.username} (${actor.id})`);
  console.log(APPLY ? 'режим: ЗАПИСЬ (--apply)' : 'режим: сухой прогон (записи не будет)');

  // Все эталоны лежат EAV-атрибутами на сущности двигателя. Тянем их одним запросом
  // через сводку по коду атрибута — join'ов на каждый атрибут было бы четыре.
  const rows = (
    await pool.query(
      `select o.id::text as id,
              o.engine_entity_id::text as engine_entity_id,
              o.operation_type, o.status, o.note, o.performed_at, o.performed_by,
              o.meta_json, o.created_at,
              a.attrs
         from operations o
         left join lateral (
           select jsonb_object_agg(ad.code, trim(both '"' from av.value_json)) as attrs
             from entities e
             join attribute_defs ad on ad.entity_type_id = e.type_id and ad.deleted_at is null
             join attribute_values av on av.entity_id = e.id
                  and av.attribute_def_id = ad.id and av.deleted_at is null
            where e.id = o.engine_entity_id and e.deleted_at is null
              and ad.code in ($1, $2, $3, $4)
         ) a on true
        where o.operation_type = 'engine_inventory' and o.deleted_at is null
        order by o.created_at`,
      ['engine_number', 'engine_brand', ENGINE_INTERNAL_NUMBER_CODE, ENGINE_INTERNAL_NUMBER_YEAR_CODE],
    )
  ).rows as Array<Record<string, unknown>>;

  console.log(`листов engine_inventory: ${rows.length}`);

  type Change = { field: HeaderField; stored: string; card: string; action: 'fill' | 'extend' };
  const planned: Array<{ row: Record<string, unknown>; changes: Change[] }> = [];
  const skipped = new Map<string, number>();
  const counts = new Map<string, number>();
  let unparsable = 0;

  /**
   * Эталон поля из карточки двигателя.
   *
   * ⚠ Внутренний номер собирается ТОЛЬКО из сохранённого года. Карточка, когда года нет,
   * подставляет текущий — для старого листа это выдумало бы год, которого в данных никогда
   * не было. Здесь такой лист получит голый номер («41»), ровно как его видит сервер.
   */
  const cardValue = (attrs: Record<string, unknown>, field: HeaderField): string => {
    if (field === 'engine_internal_number') {
      const year = Number(attrs[ENGINE_INTERNAL_NUMBER_YEAR_CODE]);
      return formatEngineInternalNumber(
        norm(attrs[ENGINE_INTERNAL_NUMBER_CODE]),
        isValidEngineInternalNumberYear(year) ? year : undefined,
      );
    }
    return norm(attrs[field]);
  };

  for (const row of rows) {
    let answers: unknown = null;
    try {
      answers = (JSON.parse(String(row.meta_json ?? '{}')) as { answers?: unknown }).answers ?? null;
    } catch {
      unparsable += 1;
      continue;
    }
    const attrs = (row.attrs ?? {}) as Record<string, unknown>;
    const changes: Change[] = [];

    for (const field of FIELDS) {
      const stored = readHeader(answers, field);
      const card = cardValue(attrs, field);
      const decision = decideHeaderFix({ stored, card });
      if (decision.action === 'skip') {
        const reason = `${FIELD_TITLE[field]}: ${decision.reason.replace(/«[^»]*»/, '«…»')}`;
        skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
        continue;
      }
      changes.push({ field, stored, card, action: decision.action });
      const k = `${FIELD_TITLE[field]}: ${decision.action === 'fill' ? 'пусто' : 'обрезано'}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (changes.length) planned.push({ row, changes });
  }

  console.log('');
  console.log(`поля прохода: ${FIELDS.map((f) => FIELD_TITLE[f]).join(', ')}`);
  console.log(`листов к правке: ${planned.length}`);
  for (const [k, n] of [...counts.entries()].sort()) console.log(`  ${k}: ${n}`);
  console.log('');
  for (const [reason, n] of [...skipped.entries()].sort()) console.log(`пропущено — ${reason}: ${n}`);
  if (unparsable) console.log(`пропущено — meta_json не разбирается: ${unparsable}`);

  const sample = planned.flatMap((x) => x.changes.filter((c) => c.action === 'extend')).slice(0, 12);
  if (sample.length) {
    console.log('');
    console.log('примеры обрезанных (до 12):');
    for (const c of sample) console.log(`  ${FIELD_TITLE[c.field]}: «${c.stored}» → «${c.card}»`);
  }

  const work = LIMIT > 0 ? planned.slice(0, LIMIT) : planned;
  if (LIMIT > 0) console.log(`\n--limit=${LIMIT}: обрабатываем ${work.length} из ${planned.length}`);
  if (!APPLY) {
    console.log('\nсухой прогон — ничего не записано. Повторите с --apply.');
    await pool.end();
    return;
  }

  let applied = 0;
  let fieldsWritten = 0;
  for (const p of work) {
    const meta = JSON.parse(String(p.row.meta_json ?? '{}')) as Record<string, unknown>;
    const answers = { ...((meta.answers ?? {}) as Record<string, unknown>) };
    for (const c of p.changes) {
      answers[c.field] = { kind: 'text', value: c.card };
      fieldsWritten += 1;
    }
    const ts = Date.now();
    await writeSyncChanges(
      [
        {
          type: 'upsert',
          table: SyncTableName.Operations,
          row_id: String(p.row.id),
          row: {
            id: String(p.row.id),
            engine_entity_id: String(p.row.engine_entity_id),
            operation_type: String(p.row.operation_type),
            status: String(p.row.status),
            note: p.row.note ?? null,
            performed_at: p.row.performed_at == null ? null : Number(p.row.performed_at),
            performed_by: p.row.performed_by ?? null,
            meta_json: JSON.stringify({ ...meta, answers }),
            created_at: Number(p.row.created_at),
            updated_at: ts,
            deleted_at: null,
          },
        },
      ],
      actor,
      { allowSyncConflicts: true },
    );
    applied += 1;
    if (applied % 100 === 0) console.log(`  … записано ${applied} из ${work.length}`);
  }
  console.log(`\nготово: листов — ${applied}, полей — ${fieldsWritten}`);
  await pool.end();
}

/**
 * Проход запускается ТОЛЬКО когда файл вызван напрямую. Без этой проверки его подхватывал
 * собственный тест: он импортирует `decideHeaderFix`, а импорт выполнял бы `main()` — на
 * раннере без базы это валило весь прогон `backend-api`, хотя все 825 тестов были зелёными.
 * `realpathSync` — потому что pnpm водит скрипты через симлинки, и голое сравнение путей
 * дало бы ложное «не точка входа».
 */
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
  main().catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}
