import 'dotenv/config';

import { pool } from '../database/db.js';

// Подсказка родителей для обобщённых позиций (план bom-simplify-2026-09 §6.4, E3).
// ТОЛЬКО ЧТЕНИЕ: скрипт не заводит родителей — их заводит оператор (решение владельца 13.09 §7 п. 5):
// «Прокладка» ×60 под разными id — это разные детали с одним именем, объединять их по имени нельзя.
//
// Кандидат — имя (нормализованное), под которым живут ≥2 активных позиции-детали и хотя бы у
// одной есть артикул. Для каждого печатается: есть ли уже безартикульная строка (готовый
// родитель), сколько строк уже привязаны, сколько — нет.
//
// Usage:
//   pnpm -F @matricarmz/backend-api warehouse:suggest-parent-positions
//   pnpm -F @matricarmz/backend-api warehouse:suggest-parent-positions -- --json
//   pnpm -F @matricarmz/backend-api warehouse:suggest-parent-positions -- --limit 50

type Row = {
  id: string;
  code: string;
  name: string;
  parent_nomenclature_id: string | null;
  directory_kind: string | null;
};

type Candidate = {
  name: string;
  total: number;
  withArticle: number;
  articleless: number;
  alreadyLinked: number;
  parentCandidateId: string | null;
};

function normalizeName(raw: string): string {
  return raw.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Math.max(1, Number(args[limitIdx + 1] ?? 100)) : 100;

  const { rows } = await pool.query<Row>(
    `select id::text, code, name, parent_nomenclature_id::text, directory_kind
       from erp_nomenclature
      where deleted_at is null and is_active = true and coalesce(directory_kind, '') in ('', 'part')`,
  );
  const byName = new Map<string, Row[]>();
  for (const r of rows) {
    const key = normalizeName(String(r.name ?? ''));
    if (!key) continue;
    const arr = byName.get(key) ?? [];
    arr.push(r);
    byName.set(key, arr);
  }
  const candidates: Candidate[] = [];
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const withArticle = group.filter((r) => String(r.code ?? '').trim() !== '');
    if (withArticle.length === 0) continue;
    const articleless = group.filter((r) => String(r.code ?? '').trim() === '' && !r.parent_nomenclature_id);
    candidates.push({
      name: String(group[0]!.name),
      total: group.length,
      withArticle: withArticle.length,
      articleless: articleless.length,
      alreadyLinked: group.filter((r) => Boolean(r.parent_nomenclature_id)).length,
      parentCandidateId: articleless.length === 1 ? articleless[0]!.id : null,
    });
  }
  candidates.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ru'));
  const shown = candidates.slice(0, limit);

  if (json) {
    console.log(JSON.stringify({ total: candidates.length, candidates: shown }, null, 2));
  } else {
    console.log(`Кандидатов в обобщённые позиции: ${candidates.length} (показано ${shown.length}). Скрипт ничего не пишет.`);
    console.log('имя | всего строк | с артикулом | без артикула (готовый родитель) | уже привязано | id родителя-кандидата');
    for (const c of shown) {
      console.log(`${c.name} | ${c.total} | ${c.withArticle} | ${c.articleless} | ${c.alreadyLinked} | ${c.parentCandidateId ?? '—'}`);
    }
    console.log('\nДальше — руками в карточке детали: у артикульных строк выбрать «Обобщённая позиция».');
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
