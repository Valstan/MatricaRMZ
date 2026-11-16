/**
 * Связывает торговые позиции (справочник из должностных карточек владельца) с
 * приказными строками набора норм (`ppe_norm_line_specs`).
 *
 * Промты КАРМАНА #20/#25: у каждой позиции набора — своя торговая номенклатура и
 * свой сертификат. Торговое имя и сертификат живут в должностной карточки выдачи
 * (по профессии), приказная строка — в приказе 767н (тоже по профессии). Связь
 * строится по «виду СИЗ» и смыслу названия: в карточке вид не написан, поэтому
 * вид выводится из торгового имени, а при равенстве видов решает совпадение
 * значимых слов («Плащ ФОРЕСТ для защиты от воды» → «Пальто, полупальто, плащ
 * для защиты от воды», а не «Костюм для защиты от механических воздействий»).
 *
 * Зимние позиции (766н, `source_kind='order766'`) из карточек не описаны: при
 * наличии основной нормы они исключаются из кандидатов — иначе «Костюм МОТОР»
 * совпал бы и с летним костюмом, и с зимним.
 *
 * Неоднозначные и не найденные — в отчёт кладовщику: это решение человека,
 * автоматика тут не решает.
 *
 * Usage:
 *   pnpm -F @matricarmz/backend-api employees:link-trade-positions            # dry-run + отчёт
 *   pnpm -F @matricarmz/backend-api employees:link-trade-positions -- --apply  # запись
 *   … --apply --entity=<id>   только один сотрудник (перезапись его позиций)
 */
import { writeFileSync, mkdirSync } from 'node:fs';

import { pool } from '../database/db.js';
import { PPE_TRADE_POSITIONS } from '../data/ppeTradePositions767.js';

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--entity=')) ?? '').split('=')[1]?.trim() || null;
const OUT_DIR = process.env.PPE_TRADE_REPORT_DIR ?? '.verifier-electron';

/** Вид СИЗ по торговому имени (в карточке вид не написан). */
const TRADE_KIND: Array<[string, string[]]> = [
  ['ноги', ['ботинки', 'сапоги', 'полуботинки', 'боты', 'башмаки']],
  ['руки', ['перчатки', 'краги', 'рукавицы', 'нарукавники']],
  ['голова', ['каска', 'кепка', 'подшлемник', 'берет']],
  ['глаза', ['очки']],
  ['дыхание', ['полумаска', 'респиратор', 'фильтр', 'маска']],
  ['слух', ['наушники', 'беруши']],
  ['колени', ['наколенник']],
  ['одежда', ['костюм', 'куртка', 'плащ', 'пальто', 'халат', 'комбинезон', 'фартук', 'жилет']],
];

/** Вид СИЗ по приказному виду (`ppe_type`). */
function kindByOrderType(ppeType: string | null): string | null {
  const text = String(ppeType ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('ног')) return 'ноги';
  if (text.includes('рук')) return 'руки';
  if (text.includes('голов')) return 'голова';
  if (text.includes('глаз')) return 'глаза';
  if (text.includes('дыхани')) return 'дыхание';
  if (text.includes('слух')) return 'слух';
  if (text.includes('одежд')) return 'одежда';
  return null;
}

/** Слова, которые ничего не различают. */
const STOP_WORDS = new Set(['для', 'от', 'и', 'в', 'по', 'с', 'к', 'а']);

/** Значимые слова торгового имени: всё длиннее трёх букв, кроме служебных. */
function significantWords(name: string): string[] {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

function tradeKindOf(name: string): string | null {
  const text = String(name ?? '').toLowerCase();
  for (const [kind, words] of TRADE_KIND) {
    if (words.some((w) => text.includes(w))) return kind;
  }
  return null;
}

function scoreBy(tradeWords: string[], orderName: string): number {
  const text = String(orderName ?? '').toLowerCase();
  let score = 0;
  for (const w of tradeWords) if (text.includes(w)) score += 1;
  return score;
}

type SpecRow = {
  id: string;
  occupationCode: string;
  name: string;
  ppeType: string | null;
  sourceKind: string;
  sortOrder: number;
};

type PlanRow = {
  occupationCode: string;
  tradeName: string;
  certificate: string | null;
  specId: string | null;
  orderName: string | null;
  kind: string | null;
  score: number | null;
  status: 'связано' | 'неоднозначно' | 'не найдено';
  candidates: string[];
};

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

  const plan: PlanRow[] = [];
  for (const trade of PPE_TRADE_POSITIONS) {
    const words = significantWords(trade.name);
    const kind = tradeKindOf(trade.name);
    let poolSpecs = specs.filter((s) => s.occupationCode === trade.occupationCode);
    if (ONLY) {
      // Ограничение на одну сущность: оставляем только её строки.
      poolSpecs = poolSpecs.filter((s) => s.id === ONLY);
    }
    if (kind) {
      const byKind = poolSpecs.filter((s) => kindByOrderType(s.ppeType) === kind);
      // Вид известен, но в приказе у профессии такой строки нет — это не «неоднозначно»,
      // а «нет пары»: значит, в приказе этой профессии такого СИЗ не предусмотрено.
      if (byKind.length === 0) {
        plan.push({
          occupationCode: trade.occupationCode,
          tradeName: trade.name,
          certificate: trade.certificate,
          specId: null,
          orderName: null,
          kind,
          score: null,
          status: 'не найдено',
          candidates: [],
        });
        continue;
      }
      poolSpecs = byKind;
    }
    // Зимние (766н) в карточках не описаны — при наличии основной нормы они вне кандидатов.
    const nonWinter = poolSpecs.filter((s) => s.sourceKind !== 'order766');
    if (nonWinter.length > 0) poolSpecs = nonWinter;

    if (poolSpecs.length === 0) {
      plan.push({
        occupationCode: trade.occupationCode,
        tradeName: trade.name,
        certificate: trade.certificate,
        specId: null,
        orderName: null,
        kind,
        score: null,
        status: 'не найдено',
        candidates: [],
      });
      continue;
    }
    const scored = poolSpecs
      .map((s) => ({ s, score: scoreBy(words, s.name) }))
      .sort((a, b) => b.score - a.score || a.s.sortOrder - b.s.sortOrder);
    const best = scored[0]!;
    const second = scored[1];
    const unambiguous = !second || best.score > second.score;
    plan.push({
      occupationCode: trade.occupationCode,
      tradeName: trade.name,
      certificate: trade.certificate,
      specId: unambiguous ? best.s.id : null,
      orderName: best.s.name,
      kind,
      score: best.score,
      status: unambiguous ? 'связано' : 'неоднозначно',
      candidates: scored.slice(0, 5).map((x) => `${x.s.name} (очки ${x.score})`),
    });
  }

  const linked = plan.filter((p) => p.status === 'связано');
  const ambiguous = plan.filter((p) => p.status === 'неоднозначно');
  const missing = plan.filter((p) => p.status === 'не найдено');

  mkdirSync(OUT_DIR, { recursive: true });
  const md = [
    '# Сверка: торговые позиции → приказные строки норм',
    '',
    `Связано: **${linked.length}** · неоднозначно: **${ambiguous.length}** · не найдено: **${missing.length}** (из ${plan.length}).`,
    '',
    '## Связано',
    '',
    '| Профессия | Торговое наименование | Приказная строка | Очки |',
    '|---|---|---|---|',
    ...linked.map((p) => `| ${p.occupationCode} | ${p.tradeName} | ${p.orderName} | ${p.score} |`),
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
    'профессия,торговое наименование,сертификат,статус,приказная строка,id приказной строки,кандидаты\n' +
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
          ].join(','),
        )
        .join('\n'),
    'utf8',
  );

  console.log(`Связано: ${linked.length} · неоднозначно: ${ambiguous.length} · не найдено: ${missing.length} (из ${plan.length})`);
  console.log(`Отчёт: ${mdPath} и ${csvPath}`);
  for (const p of ambiguous) {
    console.log(`  [неоднозначно] ${p.occupationCode} «${p.tradeName}» → ${p.candidates.join('; ')}`);
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
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const { kickPpeSyncPublisher } = await import('../services/sync/ppeSyncPublisherService.js');
  await kickPpeSyncPublisher();
  console.log(`Записано связей: ${linked.length}. Публикация в журнал синка — ок.`);
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
