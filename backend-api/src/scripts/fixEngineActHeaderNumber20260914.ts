/**
 * One-off проход по базе: вернуть в шапку листа `engine_inventory` полный номер двигателя.
 *
 * Что случилось. Автоподстановка шапки запоминала владение полем в момент ЗАПИСИ, а запись не
 * всегда закреплялась: brand-resync сохранял лист со своим, более старым снимком `answers` и
 * возвращал шапку пустой. Следующий проход читал «поле пустое, а писали его мы» как «оператор
 * стёр руками» и больше не писал никогда — номер замирал на том фрагменте, что был в полёте
 * (обычно на первой букве). Механика починена в клиенте (PR «fix(engine-act): …»), но уже
 * записанные листы сами не исправятся: подстановка не трогает непустое значение.
 *
 * Что делает скрипт — правит ТОЛЬКО явные следы этого дефекта:
 *   * шапка пуста, а у двигателя номер есть → ставим номер;
 *   * в шапке строгий ПРЕФИКС номера двигателя («2» при «2Ж03АТ») → ставим номер целиком.
 * Любое другое расхождение — это то, что оператор вписал руками, и оно неприкосновенно.
 * Регистр и пробелы по краям при сравнении не учитываются, иначе «2ж» не опознается префиксом.
 *
 * Печать от этого не менялась: печатная форма берёт номер из карточки двигателя, а из шапки —
 * только когда в карточке пусто. То есть акты печатались верно и до прохода; чинится то, что
 * оператор видит на экране и что уезжает в историю версий акта.
 *
 * Запись идёт штатным sync-путём (`writeSyncChanges`) — прямой UPDATE оставил бы
 * `last_server_seq = NULL`, и правка не доехала бы клиентам инкрементальным pull'ом (GOTCHAS M6).
 *
 * Dry-run по умолчанию. Флаги:
 *   --apply              — выполнить запись
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

import { SyncTableName } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { writeSyncChanges } from '../services/sync/syncWriteService.js';

const APPLY = process.argv.includes('--apply');
const actorArg = process.argv.find((a) => a.startsWith('--actor='));
const ACTOR_OVERRIDE = actorArg ? actorArg.split('=')[1] : null;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(0, Math.trunc(Number(limitArg.split('=')[1]))) : 0;

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
  if (!card) return { action: 'skip', reason: 'у двигателя нет номера' };
  if (key(stored) === key(card)) return { action: 'skip', reason: 'уже совпадает' };
  if (!stored) return { action: 'fill', reason: 'шапка пуста' };
  if (key(card).startsWith(key(stored))) return { action: 'extend', reason: `обрезано до «${stored}»` };
  return { action: 'skip', reason: `в шапке своё значение «${stored}»` };
}

async function main() {
  const actor = await resolveActor();
  console.log(`актор: ${actor.username} (${actor.id})`);
  console.log(APPLY ? 'режим: ЗАПИСЬ (--apply)' : 'режим: сухой прогон (записи не будет)');

  // Номер двигателя лежит EAV-атрибутом `engine_number` на сущности двигателя.
  const rows = (
    await pool.query(
      `select o.id::text as id,
              o.engine_entity_id::text as engine_entity_id,
              o.operation_type, o.status, o.note, o.performed_at, o.performed_by,
              o.meta_json, o.created_at,
              trim(both '"' from av.value_json) as card_number
         from operations o
         left join entities e on e.id = o.engine_entity_id and e.deleted_at is null
         left join attribute_defs ad on ad.entity_type_id = e.type_id
              and ad.code = 'engine_number' and ad.deleted_at is null
         left join attribute_values av on av.entity_id = e.id
              and av.attribute_def_id = ad.id and av.deleted_at is null
        where o.operation_type = 'engine_inventory' and o.deleted_at is null
        order by o.created_at`,
    )
  ).rows as Array<Record<string, unknown>>;

  console.log(`листов engine_inventory: ${rows.length}`);

  const planned: Array<{ row: Record<string, unknown>; stored: string; card: string; action: 'fill' | 'extend' }> = [];
  const skipped = new Map<string, number>();
  let emptyBrand = 0;
  let emptyInternal = 0;
  let unparsable = 0;

  for (const row of rows) {
    let answers: unknown = null;
    try {
      answers = (JSON.parse(String(row.meta_json ?? '{}')) as { answers?: unknown }).answers ?? null;
    } catch {
      unparsable += 1;
      continue;
    }
    const stored = readHeader(answers, 'engine_number');
    const card = norm(row.card_number);

    // Считаем заодно соседние поля шапки: их обнуляло тем же механизмом. Их НЕ трогаем —
    // владелец просил проход по номеру; цифры нужны, чтобы он решил про остальные.
    if (!readHeader(answers, 'engine_brand')) emptyBrand += 1;
    if (!readHeader(answers, 'engine_internal_number')) emptyInternal += 1;

    const decision = decideHeaderFix({ stored, card });
    if (decision.action === 'skip') {
      skipped.set(decision.reason.replace(/«[^»]*»/, '«…»'), (skipped.get(decision.reason.replace(/«[^»]*»/, '«…»')) ?? 0) + 1);
      continue;
    }
    planned.push({ row, stored, card, action: decision.action });
  }

  console.log('');
  console.log(`к правке: ${planned.length}`);
  console.log(`  из них пустая шапка:      ${planned.filter((p) => p.action === 'fill').length}`);
  console.log(`  из них обрезанный номер:  ${planned.filter((p) => p.action === 'extend').length}`);
  for (const [reason, n] of [...skipped.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`пропущено (${reason}): ${n}`);
  }
  if (unparsable) console.log(`пропущено (meta_json не разбирается): ${unparsable}`);
  console.log('');
  console.log(`справочно, НЕ правится этим проходом: пустая марка — ${emptyBrand}, пустой внутренний № — ${emptyInternal}`);

  const sample = planned.filter((p) => p.action === 'extend').slice(0, 15);
  if (sample.length) {
    console.log('');
    console.log('примеры обрезанных (до 15):');
    for (const p of sample) console.log(`  ${p.row.id}: «${p.stored}» → «${p.card}»`);
  }

  const work = LIMIT > 0 ? planned.slice(0, LIMIT) : planned;
  if (LIMIT > 0) console.log(`\n--limit=${LIMIT}: обрабатываем ${work.length} из ${planned.length}`);
  if (!APPLY) {
    console.log('\nсухой прогон — ничего не записано. Повторите с --apply.');
    await pool.end();
    return;
  }

  let applied = 0;
  for (const p of work) {
    const meta = JSON.parse(String(p.row.meta_json ?? '{}')) as Record<string, unknown>;
    const answers = { ...((meta.answers ?? {}) as Record<string, unknown>) };
    answers.engine_number = { kind: 'text', value: p.card };
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
    if (applied % 50 === 0) console.log(`  … записано ${applied} из ${work.length}`);
  }
  console.log(`\nготово: записано листов — ${applied}`);
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
