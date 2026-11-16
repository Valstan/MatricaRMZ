#!/usr/bin/env node
/**
 * Генератор справочника торговых позиций СИЗ из должностных карточек владельца.
 *
 * Источник — карточки выдачи СИЗ по должностям («Кладовщик промты»): в каждой
 * строке «Наименование СИЗ | № сертификата соответствия». Это фактические позиции
 * завода: торговое имя и сертификат именно этой профессии (промты КАРМАНА #20/#25,
 * решение владельца 16.11.2026: «Костюм МОТОР» — одна торговая позиция на всех,
 * а сертификат — свой у позиции набора).
 *
 * Про、职业 читать docx без зависимостей: zip — это контейнер, а word/document.xml
 * лежит внутри с deflate; распаковывает встроенный zlib.
 *
 * Usage:
 *   node scripts/generate-ppe-trade-positions.mjs --cards="D:\...\Кладовщик промты" --out=src/data/ppeTradePositions767.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).replace(/^"|"$/g, '') : fallback;
};
const cardsDir = arg('cards', '');
const outFile = arg('out', 'src/data/ppeTradePositions767.ts');
if (!cardsDir) {
  console.error('Нужен --cards="<папка с карточками>"');
  process.exit(2);
}

/**
 * Профессия приказа (код из `ppe_occupation_ref`) ↔ карточка выдачи.
 *
 * Одна карточка может описывать несколько профессий (ТОКАРЬ/ШЛИФОВЩИК/ФРЕЗЕРОВЩИК,
 * ШТУКАТУР-МАЛЯР). Карточки профессий, которых нет в приказе 767н (автослесарь,
 * кран+погрузчик, оператор станков, тракторист), в таблицу не попадают: под них
 * нет строк приказа, к которым можно было бы привязать позиции. Они помечены
 * в отчёте как «требует уточнения» — придумывать привязку нельзя.
 */
/**
 * Ключ сопоставления: в именах карточек пробелы неоднородны (двойные, висячие, их
 * может не быть вовсе — «2026г.Карточка…»), поэтому сравниваем без пробелов.
 */
function keyOf(value) {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * Профессия приказа (код из `ppe_occupation_ref`) ↔ карточка выдачи.
 *
 * Ключ — характерная часть имени карточки (без пробелов и регистра): год и слова
 * «Карточка выдачи СИЗ» в именах файлов стоят по-разному, а различать карточки
 * надо по должности. Одна карточка может описывать несколько профессий
 * (ТОКАРЬ/ШЛИФОВЩИК/ФРЕЗЕРОВЩИК, ШТУКАТУР-МАЛЯР).
 *
 * Карточки профессий, которых нет в приказе 767н (автослесарь, кран+погрузчик,
 * оператор станков, тракторист), в таблицу не попадают: под них нет строк приказа,
 * к которым можно было бы привязать позиции. Они помечены в отчёте как «требует
 * уточнения» — придумывать привязку нельзя.
 */
const CARD_OCCUPATIONS = {
  'водительавтомобиля': ['783'],
  'подсобныйрабочий': ['3640'],
  'слесарьсмр': ['4516'],
  'слесарь-ремонтник': ['4560'],
  'уборщица': ['4932'],
  'сторож': ['4732'],
  'промывщик': ['3955'],
  'испытательдвигателей': ['1418'],
  'пескоструйщик': ['3522'],
  'сварщики': ['5240'],
  'столяр': ['4727'],
  'токарь,шлифовщик,фрезеровщик': ['4872', '5160', '5066'],
  'управление': ['admin-staff'],
  'штукатур-маляр': ['5224', '1942'],
  'электрики': ['4581'],
};

/** Карточки без строк приказа — их позиции некуда привязать (ждём решения владельца). */
const UNMAPPED_CARDS = ['автослесарь', 'кран+погрузчик', 'операторстанков', 'тракторист'];

/** Достаёт `word/document.xml` из docx: zip-контейнер + deflate внутри. */
function readDocumentXml(filePath) {
  const buf = readFileSync(filePath);
  // Центральный каталог: у локального заголовка размер может быть нулевым (zip с
  // data descriptor), а в центральном — всегда верный.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`Не найден конец zip в ${filePath}`);
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name !== 'word/document.xml') continue;
    // Локальный заголовок: своя длина имени и extra — прыгаем по ним.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const out = method === 0 ? raw : inflateRawSync(raw);
    return out.toString('utf8');
  }
  throw new Error(`Не найден word/document.xml в ${filePath}`);
}

/** Строки таблиц docx: пары «ячейка1 | ячейка2». */
function readTableRows(xml) {
  const rows = [];
  const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
  const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let trMatch;
  while ((trMatch = trRe.exec(xml))) {
    const cells = [];
    let tcMatch;
    while ((tcMatch = tcRe.exec(trMatch[0]))) {
      let text = '';
      let tMatch;
      while ((tMatch = tRe.exec(tcMatch[0]))) {
        text += tMatch[1];
      }
      cells.push(
        text
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .trim(),
      );
    }
    rows.push(cells);
  }
  return rows;
}

const headerNoise = new Set(['СИЗ', 'Наименование СИЗ', 'Выдано', 'Возвращено']);

function positionsOf(xml) {
  const out = [];
  const seen = new Set();
  for (const cells of readTableRows(xml)) {
    if (cells.length < 2) continue;
    const name = cells[0];
    const certificate = cells[1];
    if (!name || headerNoise.has(name)) continue;
    if (name.length < 3) continue;
    const cert = certificate.trim() ? certificate.trim() : null;
    const key = `${name}||${cert ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, certificate: cert });
  }
  return out;
}

const positions = [];
const report = [];
// Ключ карточки — характерная часть имени: год и слова «Карточка выдачи СИЗ»
// в именах файлов стоят по-разному.
const occupationCodesOf = (cardName) => {
  const key = keyOf(cardName);
  for (const [needle, codes] of Object.entries(CARD_OCCUPATIONS)) {
    if (key.includes(needle)) return codes;
  }
  return null;
};
const isUnmapped = (cardName) => {
  const key = keyOf(cardName);
  return UNMAPPED_CARDS.some((needle) => key.includes(needle));
};
const files = readdirSync(cardsDir).filter((f) => f.endsWith('.docx'));
for (const file of files) {
  const base = path.basename(file, '.docx');
  if (/Карточка СИЗ №|Личная карточка/.test(base)) continue;
  const codes = occupationCodesOf(base);
  if (!codes) {
    if (!isUnmapped(base)) {
      console.error(`Внимание: карточка «${base}» не описана в CARD_OCCUPATIONS — пропущена.`);
    }
    continue;
  }
  const rows = positionsOf(readDocumentXml(path.join(cardsDir, file)));
  for (const code of codes) {
    for (const p of rows) {
      positions.push({ occupationCode: code, name: p.name, certificate: p.certificate });
    }
  }
  report.push(`${base} → ${codes.join(', ')}: позиций ${rows.length}`);
}

positions.sort((a, b) => (a.occupationCode === b.occupationCode ? a.name.localeCompare(b.name, 'ru') : a.occupationCode.localeCompare(b.occupationCode)));

const ts = `/**
 * Справочник торговых позиций СИЗ по должностям — из карточек выдачи владельца.
 *
 * Источник: папка «Кладовщик промты» (должностные карточки выдачи СИЗ). В каждой
 * строке — «Наименование СИЗ | № сертификата соответствия».
 *
 * Промты КАРМАНА #20/#25 (решение владельца 16.11.2026): «Костюм МОТОР» — одна
 * торговая позиция на все должности (вещь одна и та же), а сертификат — свой у
 * позиции набора: один и тот же товар по разным профессиям имеет разные
 * сертификаты («Перчатки х.б. … ЛАЙТ/BERD»: .56518/24, .52518/25, .00280/21).
 *
 * Файл сгенерирован: \`backend-api/scripts/generate-ppe-trade-positions.mjs\`.
 * Правьте карточки у владельца и генерируйте заново — руками здесь ничего не меняем.
 */

export type PpeTradePosition = {
  /** Код профессии приказа (\`ppe_occupation_ref.code\`). */
  occupationCode: string;
  /** Торговое наименование позиции: «Костюм МОТОР». */
  name: string;
  /** № сертификата соответствия; \`null\` — в карточке не заполнен. */
  certificate: string | null;
};

export const PPE_TRADE_POSITIONS: readonly PpeTradePosition[] = [
${positions
  .map(
    (p) =>
      `  { occupationCode: ${JSON.stringify(p.occupationCode)}, name: ${JSON.stringify(p.name)}, certificate: ${
        p.certificate == null ? 'null' : JSON.stringify(p.certificate)
      } },`,
  )
  .join('\n')}
];
`;

writeFileSync(outFile, ts, 'utf8');
console.log(report.join('\n'));
console.log(`Позиций: ${positions.length}; записано: ${outFile}`);
