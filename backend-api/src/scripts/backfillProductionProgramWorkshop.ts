import 'dotenv/config';

import { pool } from '../database/db.js';

// production-programs:backfill-workshop — проставить связь с цехом программам
// производства, у которых цех записан ТЕКСТОМ («Цех № 1»), а не id справочника
// (владелец 24.11.2026: «надо чтобы цех выбирался из базы»).
//
// ПРАВИЛО (решение владельца): заполняем ТОЛЬКО при ОДНОЗНАЧНОМ совпадении со
// справочником. Неоднозначные (два живых цеха с одинаковым именем) и несовпавшие
// НЕ угадываем — они попадают в отчёт и ждут решения владельца. Авто-склейка по
// natural key запрещена (D-238), неоднозначный ключ запрещает переход (G659/G660).
//
// Что делает:
//   · читает ЖИВЫЕ цехи из `directory_workshops`;
//   · у каждой программы без `workshop_id` ищет цех по нормализованному ИМЕНИ;
//   · при однозначном совпадении пишет `workshop_id` (и снимок имени не трогает:
//     печать и выгрузка идут по `shop`, и образец «Цех № 1» должен уйти как раньше);
//   · пишет через `sync_status = 'pending'` — дальше публикатор зеркала доводит
//     строку до журнала, и клиенты видят связь обычным pull'ом.
//
// Идемпотентно: повторный прогон не меняет уже связанные строки.
//
// Usage:
//   corepack pnpm -F @matricarmz/backend-api production-programs:backfill-workshop            # dry-run
//   corepack pnpm -F @matricarmz/backend-api production-programs:backfill-workshop -- --apply
//
// Прод-гейт #025: `--apply` — только после того, как владелец видел список из dry-run.
//
// Коды возврата: 0 — ок; 2 — отказ/ошибка.

type DirRow = { id: string; code: string; name: string };

export type WorkshopMatch = { id: string; name: string };

export type MatchVerdict =
  | { action: 'matched'; workshop: WorkshopMatch }
  | { action: 'ambiguous'; candidates: string[] }
  | { action: 'unmatched' }
  | { action: 'already-linked' };

/** Нормализация имени цеха: регистр, «ё», «№», лишние пробелы. */
export function normalizeWorkshopText(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll('№', '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Цех по имени программы — ТОЛЬКО при однозначном совпадении.
 *
 * Несколько живых цехов с одинаковым именем ⇒ неоднозначно ⇒ НЕ угадываем
 * (такие строки идут в отчёт владельцу).
 */
export function decideWorkshopMatch(shop: string, dir: DirRow[]): MatchVerdict {
  const key = normalizeWorkshopText(shop);
  if (!key) return { action: 'unmatched' };
  const hits = dir.filter((w) => normalizeWorkshopText(w.name) === key);
  if (hits.length === 0) return { action: 'unmatched' };
  if (hits.length > 1) {
    return { action: 'ambiguous', candidates: hits.map((w) => `${w.code}=«${w.name}»`) };
  }
  const hit = hits[0]!;
  return { action: 'matched', workshop: { id: hit.id, name: hit.name } };
}

function parseArgs(argv: string[]): { apply: boolean } {
  let apply = false;
  for (const a of argv) {
    if (a === '--apply') apply = true;
    else if (a === '--') continue;
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  return { apply };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `production-programs:backfill-workshop — ${args.apply ? 'ЗАПИСЬ' : 'dry-run, ничего не меняет'}`,
  );

  const dirRes = (await pool.query(
    `SELECT id::text AS id, code::text AS code, name::text AS name
       FROM directory_workshops
      WHERE deleted_at IS NULL
      ORDER BY display_order, name`,
  )) as { rows: DirRow[] };
  const dir = dirRes.rows.filter((w) => w.id && w.name);
  console.log(`Живых цехов в справочнике: ${dir.length}`);
  for (const w of dir) console.log(`  ${w.code} = «${w.name}» (${w.id})`);

  const progRes = (await pool.query(
    `SELECT id::text AS id, title::text AS title, shop::text AS shop, workshop_id::text AS workshop_id
       FROM erp_production_programs
      WHERE deleted_at IS NULL
      ORDER BY created_at`,
  )) as { rows: Array<{ id: string; title: string; shop: string; workshop_id: string | null }> };

  const counts = { matched: 0, already: 0, unmatched: 0, ambiguous: 0 };
  const unmatched: Array<{ id: string; title: string; shop: string }> = [];
  const ambiguous: Array<{ id: string; title: string; shop: string; candidates: string[] }> = [];

  for (const p of progRes.rows) {
    if (p.workshop_id) {
      counts.already += 1;
      continue;
    }
    const verdict = decideWorkshopMatch(String(p.shop ?? ''), dir);
    if (verdict.action === 'matched') {
      counts.matched += 1;
      console.log(`  MATCH  ${p.id} «${p.shop}» → «${verdict.workshop.name}» (${verdict.workshop.id})`);
      if (args.apply) {
        await pool.query(
          `UPDATE erp_production_programs
              SET workshop_id = $1, updated_at = $2, sync_status = 'pending'
            WHERE id = $3 AND workshop_id IS NULL`,
          [verdict.workshop.id, Date.now(), p.id],
        );
      }
      continue;
    }
    if (verdict.action === 'ambiguous') {
      counts.ambiguous += 1;
      ambiguous.push({ id: p.id, title: String(p.title ?? ''), shop: String(p.shop ?? ''), candidates: verdict.candidates });
      continue;
    }
    counts.unmatched += 1;
    unmatched.push({ id: p.id, title: String(p.title ?? ''), shop: String(p.shop ?? '') });
  }

  console.log(
    `\nИтог: программ ${progRes.rows.length} · связать ${counts.matched} · ` +
      `уже связано ${counts.already} · не найдено ${counts.unmatched} · неоднозначно ${counts.ambiguous}.`,
  );
  if (unmatched.length > 0) {
    console.log(`\nНе найдено в справочнике (${unmatched.length}) — руками, решения владельца:`);
    for (const u of unmatched) console.log(`  ${u.id} | «${u.shop}» | ${u.title}`);
  }
  if (ambiguous.length > 0) {
    console.log(`\nНеоднозначно (${ambiguous.length}) — руками, решения владельца:`);
    for (const a of ambiguous) console.log(`  ${a.id} | «${a.shop}» | ${a.title} | ${a.candidates.join(' / ')}`);
  }
  if (!args.apply && (counts.matched > 0 || counts.unmatched > 0 || counts.ambiguous > 0)) {
    console.log('\nЭто был dry-run. Запись — с --apply (после того, как владелец увидел список).');
  }
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
