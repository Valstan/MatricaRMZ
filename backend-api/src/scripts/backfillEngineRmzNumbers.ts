import 'dotenv/config';

import { pool } from '../database/db.js';
import { reconcileEngineNumbers } from '../services/engineNumbersService.js';

// engines:backfill-rmz-numbers — первичная нумерация существующих двигателей сквозным
// номером карточки `RMZ451` (план engine-rmz-numbers-2026-10, решение владельца 27.10.2026).
//
// Правила:
//   - нумеруются ЖИВЫЕ карточки (`entities` + тип `engine`, без tombstone): сначала те, у кого
//     нет даты прихода (у них нет ни документа, ни даты — номер карточки и есть опознание),
//     затем остальные по дате прихода: самый ранний приезд получает следующий номер;
//   - номер принадлежит СОЗДАНИЮ карточки, поэтому порядок фиксируется один раз и больше
//     не пересчитывается: реестр — не «текущий список двигателей», а история выдач;
//   - повторный запуск идемпотентен: уже выданные номера не трогаются, новые не выдаются,
//     если не появилось новых карточек;
//   - пишет через writeSyncChanges (журнал + seq) — парк видит обычным pull.
//
// Тот же проход, что работает после push-батча и при старте сервера: бэкфилл и обычная
// работа идут одной веткой кода и не могут разойтись в поведении.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api engines:backfill-rmz-numbers            # dry-run
//   corepack pnpm -F @matricarmz/backend-api engines:backfill-rmz-numbers -- --apply
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

type Counts = {
  alive: number;
  aliveWithoutNumber: number;
  numbers: number;
  activeNumbers: number;
  activeWithMissingCard: number;
};

async function loadCounts(): Promise<Counts> {
  const res = (await pool.query(
    `SELECT
       (SELECT count(*) FROM entities e
          JOIN entity_types et ON et.id = e.type_id AND et.code = 'engine'
         WHERE e.deleted_at IS NULL)::int AS alive,
       (SELECT count(*) FROM entities e
          JOIN entity_types et ON et.id = e.type_id AND et.code = 'engine'
          LEFT JOIN erp_engine_numbers n ON n.id = e.id
         WHERE e.deleted_at IS NULL AND n.id IS NULL)::int AS alive_without_number,
       (SELECT count(*) FROM erp_engine_numbers)::int AS numbers,
       (SELECT count(*) FROM erp_engine_numbers WHERE status = 'active')::int AS active_numbers,
       (SELECT count(*) FROM erp_engine_numbers n
          LEFT JOIN entities e ON e.id = n.id
         WHERE n.status = 'active' AND (e.id IS NULL OR e.deleted_at IS NOT NULL))::int AS active_with_missing_card`,
  )) as { rows: Array<Record<string, unknown>> };
  const row = res.rows[0] ?? {};
  return {
    alive: Number(row['alive'] ?? 0),
    aliveWithoutNumber: Number(row['alive_without_number'] ?? 0),
    numbers: Number(row['numbers'] ?? 0),
    activeNumbers: Number(row['active_numbers'] ?? 0),
    activeWithMissingCard: Number(row['active_with_missing_card'] ?? 0),
  };
}

function parseArgs(argv: string[]): { apply: boolean } {
  const out = { apply: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`engines:backfill-rmz-numbers — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`);

  const before = await loadCounts();
  console.log(
    `до: живых двигателей ${before.alive}, без номера ${before.aliveWithoutNumber}, ` +
      `номеров в реестре ${before.numbers} (активных ${before.activeNumbers}), ` +
      `активных с исчезнувшей карточкой ${before.activeWithMissingCard}`,
  );

  if (!args.apply) {
    if (before.aliveWithoutNumber > 0) console.log('Повторить с --apply для записи.');
    await pool.end();
    return;
  }

  let issued = 0;
  let markedDeleted = 0;
  // Проход берёт до 2000 карточек: 2570 живых двигателей не влезают в один заход.
  for (let round = 1; round <= 50; round += 1) {
    const r = await reconcileEngineNumbers();
    if (r.busy) throw new Error('сверка уже идёт в этом процессе — этого быть не может в скрипте');
    issued += r.issued;
    markedDeleted += r.markedDeleted;
    console.log(`проход ${round}: выдано ${r.issued}, помечено удалёнными ${r.markedDeleted}`);
    if (r.issued === 0 && r.markedDeleted === 0) break;
  }

  const after = await loadCounts();
  console.log(
    `итого: выдано ${issued}, помечено удалёнными ${markedDeleted}; ` +
      `после — номеров ${after.numbers}, живых без номера ${after.aliveWithoutNumber}`,
  );
  if (after.aliveWithoutNumber > 0) {
    console.error(`ВНИМАНИЕ: ${after.aliveWithoutNumber} живых двигателей остались без номера`);
    await pool.end();
    process.exit(1);
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  await pool.end().catch(() => undefined);
  process.exit(2);
});
