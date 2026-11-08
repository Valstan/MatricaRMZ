// Ротация done-индекса: приводит форму строк к правилу «тезис + короткий итог»
// и (по желанию) уводит записи старше границы в архив поколения 3.x.
//
// Зачем: правило «одна строка» в шапке docs/COMPLETED.md было, а форма ему не
// следовала — строки выросли в абзацы (медиана 1 259 байт), и индекс упёрся в
// потолок 300 КБ. Этот скрипт — повторяемая операция: раз в месяц (или когда
// файл подрос) прогоняется с границей даты, и старые записи уходят в архив.
//
// Запуск:
//   node scripts/docs/rotate-completed-index.mjs --dry                 # только показать
//   node scripts/docs/rotate-completed-index.mjs                       # сжать итоги
//   node scripts/docs/rotate-completed-index.mjs --cut 2026-10-01      # + вынести старое в архив
//
// Опции:
//   --cut <YYYY-MM-DD>  записи стр этой даты уходят в архив (по умолчанию — ничего не выносить)
//   --max <N>           максимум символов в колонке «Итог» (по умолчанию 320)
//   --archive <путь>    куда выносить (по умолчанию — по кварталу покрытого периода)
//   --dry               ничего не писать, только показать сводку

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const INDEX = resolve(ROOT, 'docs/COMPLETED.md');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const MAX = Number(arg('max', '320'));
const CUT = arg('cut', null);
const DRY = has('dry');

/** Граница реза: точка/точка с запятой/двоеточие/запятая + пробел. */
const BOUNDARY = /[.;:,]\s/;

/**
 * Обрезает текст до лимита по границе предложения. Не режет внутри markdown-ссылки
 * (`[текст](url)`) — такую ссылку либо переносим целиком, либо отбрасываем.
 */
export function squeeze(text, max) {
  if (!text || text.length <= max) return { text, cut: false };
  let head = text.slice(0, max);
  // Незакрытая ссылка в хвосте — отрезаем до её начала, чтобы не оставить битый markdown.
  const openLink = head.lastIndexOf('](');
  if (openLink > head.lastIndexOf(')')) {
    const linkStart = head.lastIndexOf('[');
    if (linkStart > 0) head = head.slice(0, linkStart);
  }
  // Ищем последнюю границу не ближе 55% лимита, чтобы не срезать пол-фразы.
  let cutAt = -1;
  for (let i = head.length - 1; i >= Math.floor(max * 0.55); i -= 1) {
    if (BOUNDARY.test(head[i])) {
      cutAt = i + 1;
      break;
    }
  }
  if (cutAt > 0) head = head.slice(0, cutAt);
  return { text: `${head.replace(/[\s,;:.—–-]+$/u, '')}…`, cut: true };
}

/**
 * Разбирает строку таблицы и ПОЧИНИТ разметку: в части строк внутри ячейки «Итог»
 * оказался неэкранированный «|» (тогда markdown-таблица ломается), а у одной строки
 * не хватало завершающего «|». Границы ячеек известны по трём первым разделителям:
 * дата | тезис | релиз/PR | итог.
 */
function parseRow(line) {
  const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
  if (!m) return null;
  const date = m[1];
  const rest = line.slice(m[0].length);
  const i2 = rest.indexOf('|');
  if (i2 < 0) return null;
  const title = rest.slice(0, i2).trim();
  const rest2 = rest.slice(i2 + 1);
  const i3 = rest2.indexOf('|');
  if (i3 < 0) return null;
  const rel = rest2.slice(0, i3).trim();
  let outcome = rest2.slice(i3 + 1).trim();
  // Завершающий «|» — служебный; внутренние «|» внутри итога экранируем.
  if (outcome.endsWith('|') && !outcome.endsWith('\\|')) outcome = outcome.slice(0, -1).trim();
  outcome = outcome.replace(/(?<!\\)\|/g, '\\|');
  return { date, title, rel, outcome };
}

/**
 * Убирает «битый хвост» после обрезки: незакрытый инлайн-код (`код) и непарные скобки.
 * Обрезка по границе предложения может разрезать `` `service.ts` `` или «(все в `main`)» —
 * в индексе это выглядит как мусор, поэтому хвост дорезается.
 */
export function trimBrokenTail(text) {
  let out = text;
  const ticks = (out.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) {
    const i = out.lastIndexOf('`');
    if (i > 0) out = out.slice(0, i);
  }
  const open = (out.match(/\(/g) ?? []).length;
  const close = (out.match(/\)/g) ?? []).length;
  if (open > close) {
    const i = out.lastIndexOf('(');
    if (i > 0) out = out.slice(0, i);
  }
  return out.replace(/[\s,;:.—–-]+$/u, '');
}

const raw = readFileSync(INDEX, 'utf8');
const lines = raw.split('\n');

const kept = [];
const archived = [];
let squeezed = 0;
let moved = 0;
let repaired = 0;
let skipped = 0;

for (const line of lines) {
  if (!line.startsWith('|')) {
    kept.push(line);
    continue;
  }
  const parsed = parseRow(line);
  if (!parsed) {
    kept.push(line);
    skipped += 1;
    continue;
  }
  const rebuilt = `| ${parsed.date} | ${parsed.title} | ${parsed.rel} | ${parsed.outcome} |`;
  if (rebuilt !== line) repaired += 1;
  const squeezedOutcome = squeeze(parsed.outcome.replace(/\\\|/g, '|'), MAX);
  if (squeezedOutcome.cut) squeezed += 1;
  const cleanOutcome = trimBrokenTail(squeezedOutcome.text);
  const row = `| ${parsed.date} | ${parsed.title} | ${parsed.rel} | ${cleanOutcome.replace(/\|/g, '\\|')} |`;
  if (CUT && parsed.date < CUT) {
    archived.push(row);
    moved += 1;
  } else {
    kept.push(row);
  }
}

const summary = {
  'строк сжато': squeezed,
  'строк разметка починена': repaired,
  'строк ушло в архив': moved,
  'строк пропущено (не строка-запись)': skipped,
  'размер индекса до': Buffer.byteLength(raw, 'utf8'),
  'размер индекса после': Buffer.byteLength(kept.join('\n'), 'utf8'),
  'в архив уйдёт байт': archived.reduce((a, l) => a + Buffer.byteLength(l, 'utf8') + 1, 0),
};
console.log(summary);

if (DRY) {
  console.log('\n--- примеры после сжатия (первые 3) ---');
  kept
    .filter((l) => l.startsWith('| 2026'))
    .slice(0, 3)
    .forEach((l) => console.log(l.slice(0, 400)));
  process.exit(0);
}

if (archived.length > 0) {
  // Имя архива — по кварталу покрытого периода: граница 2026-10-01 → записи строго
  // раньше → август-сентябрь → 2026Q3.
  let archiveRel = arg('archive', null);
  if (!archiveRel) {
    const d = new Date(`${CUT}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    archiveRel = `docs/_archive/COMPLETED-3x-${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}.md`;
  }
  const archivePath = resolve(ROOT, archiveRel);
  if (!existsSync(archivePath)) {
    mkdirSync(dirname(archivePath), { recursive: true });
    writeFileSync(
      archivePath,
      `# Completed — закрытый архив поколения 3.x\n\n> Часть done-индекса, вынесенная из живого файла по возрасту: записи строго **раньше** ${CUT}. Только чтение: сюда не дописывают. Живой индекс — [../COMPLETED.md](../COMPLETED.md).\n\n| ✅ | Нитка | Релиз / PR | Итог |\n|---|---|---|---|\n`,
      'utf8',
    );
  }
  writeFileSync(archivePath, `${readFileSync(archivePath, 'utf8').trimEnd()}\n${archived.join('\n')}\n`, 'utf8');
  console.log(`архив: ${archivePath}`);
}

writeFileSync(INDEX, kept.join('\n'), 'utf8');
console.log(`индекс записан: ${INDEX}`);
