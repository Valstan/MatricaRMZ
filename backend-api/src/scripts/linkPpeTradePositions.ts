/**
 * Связывает торговые позиции (справочник из должностных карточек владельца) с
 * приказными строками набора норм (`ppe_norm_line_specs`).
 *
 * Промты КАРМАНА #20/#25: у каждой позиции набора — своя торговая номенклатура и
 * свой сертификат. Торговое имя и сертификат живут в должностной карточке выдачи
 * (по профессии), приказная строка — в приказе 767н (тоже по профессии). Связь
 * строится по виду СИЗ и смыслу названия; подбор живёт в
 * [`ppeTradeLinking`](../services/ppeTradeLinking.js).
 *
 * Спорные места (две вещи претендуют на одну норму) решает кладовщик: его ответы
 * лежат в бланке выбора (CSV) и подаются флагом `--choices` — подбор их не
 * переигрывает. Без бланка спорные строки уходят в отчёт «требует выбора».
 *
 * Usage:
 *   pnpm -F @matricarmz/backend-api employees:link-trade-positions            # dry-run + отчёт
 *   pnpm -F @matricarmz/backend-api employees:link-trade-positions -- --apply  # запись
 *   … --apply --entity=<id>   только одна приказная строка (перезапись её позиций)
 *   … --choices=<csv>         бланк выбора кладовщика (решения применяются как есть)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import { pool } from '../database/db.js';
import { PPE_TRADE_POSITIONS } from '../data/ppeTradePositions767.js';
import {
  linkTradePositions,
  parseChoicesCsv,
  type SpecRow,
  type TradeChoice,
} from '../services/ppeTradeLinking.js';

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--entity=')) ?? '').split('=')[1]?.trim() || null;
const CHOICES = (process.argv.find((a) => a.startsWith('--choices=')) ?? '').split('=')[1]?.trim() || null;
const OUT_DIR = process.env.PPE_TRADE_REPORT_DIR ?? '.verifier-electron';

async function main() {
  const specRes = await pool.query<SpecRow>(
    `select s.id::text as id, o.code as "occupationCode", s.name, s.ppe_type as "ppeType",
            s.source_kind as "sourceKind", s.sort_order as "sortOrder"
       from ppe_norm_line_specs s
       join ppe_occupation_ref o on o.id = s.occupation_id
      where s.deleted_at is null
      order by o.code, s.sort_order`,
  );
  const specs = specRes.rows;

  let choices: TradeChoice[] = [];
  if (CHOICES) {
    choices = parseChoicesCsv(readFileSync(CHOICES, 'utf8'));
    console.log(`Бланк выбора кладовщика: ${CHOICES} — решений прочитано: ${choices.length}`);
  }

  const plan = linkTradePositions(specs, PPE_TRADE_POSITIONS, choices, ONLY);

  const linked = plan.filter((p) => p.status === 'связано');
  const ambiguous = plan.filter((p) => p.status === 'неоднозначно');
  const extra = plan.filter((p) => p.status === 'лишняя');
  const missing = plan.filter((p) => p.status === 'не найдено');

  mkdirSync(OUT_DIR, { recursive: true });
  const md = [
    '# Сверка: торговые позиции → приказные строки норм',
    '',
    `Связано: **${linked.length}** · лишних (в приказе нет своей строки): **${extra.length}** · неоднозначно: **${ambiguous.length}** · не найдено: **${missing.length}** (из ${plan.length}).`,
    choices.length ? `Решения кладовщика применены: **${choices.length}**.` : 'Решения кладовщика не подавались (--choices).',
    '',
    '## Связано',
    '',
    '| Профессия | Торговое наименование | Приказная строка | Очки |',
    '|---|---|---|---|',
    ...linked.map((p) => `| ${p.occupationCode} | ${p.tradeName} | ${p.orderName} | ${p.score} |`),
    '',
    '## Лишние: в приказе для профессии нет своей строки',
    '',
    '| Профессия | Торговое наименование | Почему без строки |',
    '|---|---|---|',
    ...extra.map((p) => `| ${p.occupationCode} | ${p.tradeName} | ${p.note ?? ''} |`),
    '',
    '## Требует выбора кладовщика',
    '',
    '| Профессия | Торговое наименование | Кандидаты |',
    '|---|---|---|',
    ...ambiguous.map((p) => `| ${p.occupationCode} | ${p.tradeName} | ${p.candidates.join('; ')} |`),
    '',
    '## Не найдено приказной строки',
    '',
    '| Профессия | Торговое наименование |',
    '|---|---|',
    ...missing.map((p) => `| ${p.occupationCode} | ${p.tradeName} |`),
    '',
  ].join('\n');
  const mdPath = `${OUT_DIR}/ppe-trade-link-report.md`;
  writeFileSync(mdPath, md, 'utf8');
  const csvPath = `${OUT_DIR}/ppe-trade-link-report.csv`;
  writeFileSync(
    csvPath,
    'профессия,торговое наименование,сертификат,статус,приказная строка,id приказной строки,кандидаты,примечание\n' +
      plan
        .map((p) =>
          [
            p.occupationCode,
            `"${p.tradeName.replace(/"/g, '""')}"`,
            `"${(p.certificate ?? '').replace(/"/g, '""')}"`,
            p.status,
            `"${(p.orderName ?? '').replace(/"/g, '""')}"`,
            p.specId ?? '',
            `"${p.candidates.join('; ').replace(/"/g, '""')}"`,
            `"${(p.note ?? '').replace(/"/g, '""')}"`,
          ].join(','),
        )
        .join('\n'),
    'utf8',
  );

  console.log(
    `Связано: ${linked.length} · лишних: ${extra.length} · неоднозначно: ${ambiguous.length} · не найдено: ${missing.length} (из ${plan.length})`,
  );
  console.log(`Отчёт: ${mdPath} и ${csvPath}`);
  for (const p of ambiguous) {
    console.log(`  [неоднозначно] ${p.occupationCode} «${p.tradeName}» → ${p.candidates.join('; ')}`);
  }
  for (const p of extra) {
    console.log(`  [лишняя] ${p.occupationCode} «${p.tradeName}» — ${p.note ?? ''}`);
  }
  for (const p of missing) {
    console.log(`  [не найдено] ${p.occupationCode} «${p.tradeName}»`);
  }

  if (!APPLY) {
    console.log('РЕЖИМ: dry-run (ничего не записано; добавьте --apply)');
    return;
  }

  // Запись идёт в приказные строки: trade_name и certificate. Строка помечается
  // `pending`, и штатный публикатор СИЗ увозит её в журнал синка — клиенты её видят.
  const now = Date.now();
  const client = await pool.connect();
  const cleared: string[] = [];
  try {
    await client.query('BEGIN');
    for (const p of linked) {
      await client.query(
        `update ppe_norm_line_specs
            set trade_name = $2, certificate = $3, updated_at = $4, sync_status = 'pending'
          where id = $1`,
        [p.specId, p.tradeName, p.certificate, now],
      );
    }
    // Уборка: в строке осталось имя из справочника, но по новому плану этой
    // позиции у строки нет (например, перчатки маляра уехали в свою строку, а в
    // «Нарукавниках…» осталось их имя). Чистим только значения из справочника —
    // правку кладовщика вручную (имя не из справочника) не трогаем.
    const linkedBySpec = new Map(linked.map((p) => [p.specId!, p.tradeName]));
    const machineNames = new Set(PPE_TRADE_POSITIONS.map((p) => p.name));
    const stale = await client.query<{ id: string; trade_name: string | null }>(
      `select id::text as id, trade_name from ppe_norm_line_specs
        where deleted_at is null and trade_name is not null`,
    );
    for (const row of stale.rows) {
      const current = String(row.trade_name ?? '').trim();
      if (!machineNames.has(current)) continue;
      const planned = linkedBySpec.get(row.id);
      if (planned === current) continue;
      await client.query(
        `update ppe_norm_line_specs
            set trade_name = null, certificate = null, updated_at = $2, sync_status = 'pending'
          where id = $1`,
        [row.id, now],
      );
      cleared.push(`${row.id} — было «${current}»${planned ? `, стало «${planned}»` : ', строка без позиции'}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(`Записано связей: ${linked.length}. Очищено устаревших значений: ${cleared.length}.`);
  for (const line of cleared) console.log(`  очищено: ${line}`);

  const { kickPpeSyncPublisher } = await import('../services/sync/ppeSyncPublisherService.js');
  await kickPpeSyncPublisher();
  console.log('Публикация в журнал синка — ок.');
}

main()
  .then(async () => {
    await pool.end();
  })
  .catch(async (e) => {
    console.error('FATAL:', e instanceof Error ? e.message : String(e));
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
