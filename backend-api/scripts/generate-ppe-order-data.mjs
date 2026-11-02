/**
 * Генератор данных приказа о СИЗ (Минтруд 767н, Приложение №1).
 *
 * Одноразовый помощник: читает TSV-выгрузку таблицы 2 документа и пишет
 *   1) `backend-api/src/data/ppeOrderNorms767.ts` — источник правды по нормам
 *      приказа (человекочитаемый, ревьюится глазами);
 *   2) `backend-api/drizzle/0118_ppe_order_norms_seed.sql` — сид-миграция
 *      со стабильными UUID (те же, что в TS-файле).
 *
 * В репо попадают оба файла; сам TSV из репо не хранится (в нём данные
 * документа, они уже разложены в TS-файле).
 *
 * Запуск: node scripts/generate-ppe-order-data.mjs <путь-к-tsv>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const tsvPath = process.argv[2];
if (!tsvPath) {
  console.error('usage: node scripts/generate-ppe-order-data.mjs <tsv>');
  process.exit(1);
}

const raw = readFileSync(tsvPath, 'utf8');
const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '');

/** Стабильный UUID из строки: миграция и скрипты берут одни и те же ссылки. */
function stableUuid(seed) {
  const h = createHash('sha256').update(`ppe-order-767n:${seed}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), `5${h.slice(13, 16)}`, `a${h.slice(17, 20)}`, h.slice(20, 32)].join('-');
}

/** Нормализация имени для сопоставления с номенклатурой. */
function normKey(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

// ── Разбор таблицы ────────────────────────────────────────────────────────────
// В документе ячейки объединены (merged), и из-за этого колонки «плавают»:
//  - у групп «персонал» первая строка сдвинута влево (профессия в первой ячейке,
//    дальше тип СИЗ, наименование, норма);
//  - строки приказа 766н идут отдельными строками без профессии — они относятся
//    к профессии ВЫШЕ.
//
// Поэтому строка разбирается по заполненности, а не по номерам колонок: норма —
// последняя непустая ячейка; если последняя пуста, норма на ячейку левее.
const groups = [];
let cur = null;
for (const line of lines) {
  const c = line.split(' | ');
  const cells = c.map((v) => (v ?? '').trim());

  // Откуда читать норму: с конца строки, сдвигаясь влево на пустые хвосты.
  let normIdx = cells.length - 1;
  while (normIdx >= 0 && cells[normIdx] === '') normIdx -= 1;
  if (normIdx < 1) continue;
  const norm = cells[normIdx];
  const name = cells[normIdx - 1] ?? '';
  const type = cells[normIdx - 2] ?? '';

  const head = cells[0] ?? '';
  // Голова строки: либо новый пункт приложения, либо профессия без пункта
  // («Инженерно – технический персонал»), либо строка приказа 766н.
  if (head !== '' && !/766н/.test(head)) {
    const isPoint = /№\s*\d+/.test(head);
    cur = {
      point: isPoint ? head : '',
      post: isPoint ? cells[1] ?? '' : head,
      rows: [],
    };
    groups.push(cur);
  }
  if (!cur) continue;
  // Примечание приказа к строке 766н: колонка профессии у них несёт пометку
  // («При наружных работах»), а не профессию.
  const note = /766н/.test(head) && cells[1] ? cells[1] : null;
  cur.rows.push({ type, name, qty: norm, isOrder766: /766н/.test(head), note });
}

// ── Профессии ─────────────────────────────────────────────────────────────────
function occupationCode(point, post) {
  const num = point.match(/№\s*(\d+)/);
  if (num) return num[1];
  return post.includes('технический') ? 'tech-staff' : 'admin-staff';
}

const occupations = [];
const seenCode = new Set();
for (const g of groups) {
  if (!g.post) continue;
  const code = occupationCode(g.point, g.post);
  if (seenCode.has(code)) continue;
  seenCode.add(code);
  const num = g.point.match(/№\s*(\d+)/);
  occupations.push({
    id: stableUuid(`occ:${code}`),
    code,
    postTitle: g.post.replace(/\s*–\s*/g, ' – ').trim(),
    tonKind: num ? 'ton' : 'local',
    tonLabel: num ? `Пункт № ${num[1]}` : null,
    tonYear: num ? 2021 : null,
  });
}

// ── Строки приказа ───────────────────────────────────────────────────────────
const specs = [];
const specCounters = new Map();
for (const g of groups) {
  if (!g.post) continue;
  const code = occupationCode(g.point, g.post);
  const num = g.point.match(/№\s*(\d+)/);
  let order = 0;
  for (const row of g.rows) {
    order += 1;
    const sourceKind = row.isOrder766 ? 'order766' : 'ton';
    const counterKey = `${code}:${sourceKind}`;
    const idx = (specCounters.get(counterKey) ?? 0) + 1;
    specCounters.set(counterKey, idx);
    specs.push({
      id: stableUuid(`spec:${code}:${sourceKind}:${idx}:${normKey(row.name)}`),
      occupationCode: code,
      sourceKind,
      sourceLabel: row.isOrder766 ? '№ 766н Прил.4' : num ? `Пункт № ${num[1]}` : null,
      ppeType: row.type,
      name: row.name,
      sourceRef: row.qty,
      sortOrder: order,
      note: row.note && row.note !== g.post ? row.note : null,
    });
  }
}

// ── Наборы норм: по профессии и по источнику ─────────────────────────────────
const normSets = [];
for (const occ of occupations) {
  const hasTon = specs.some((s) => s.occupationCode === occ.code && s.sourceKind === 'ton');
  const has766 = specs.some((s) => s.occupationCode === occ.code && s.sourceKind === 'order766');
  if (hasTon) {
    normSets.push({
      id: stableUuid(`set:${occ.code}:ton`),
      occupationCode: occ.code,
      sourceKind: 'ton',
      sourceLabel: occ.tonLabel,
      name: occ.tonLabel ? `${occ.postTitle} (${occ.tonLabel})` : occ.postTitle,
      season: null,
    });
  }
  if (has766) {
    normSets.push({
      id: stableUuid(`set:${occ.code}:order766`),
      occupationCode: occ.code,
      sourceKind: 'order766',
      sourceLabel: '№ 766н Прил.4',
      name: `${occ.postTitle} (СИЗ от пониженных температур, приказ 766н Прил.4)`,
      season: 'winter',
    });
  }
}

// ── Разбор нормы приказа ──────────────────────────────────────────────────────
// Правила те же, что в домене (`parseOrderNormQty`): количество, единица измерения
// и форма срока. Дублируем их здесь только для сида (SQL не умеет звать TS) —
// расхождение ловит тест `ppeOrderNorms.seed.test.ts`.
function parseNorm(raw) {
  const text = String(raw ?? '')
    .replace(/ё/gi, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return { qty: 1, unit: 'шт.', wearKind: 'months', wearMonths: 12, periodText: null };
  const yearsMatch = text.match(/(\d+)\s*(?:лет|года|год)(?![а-яё])/);
  const qtyMatch = text.match(/(\d+)\s*(комплект|пара|пар|шт)/);
  const qty = qtyMatch ? Number(qtyMatch[1]) : 1;
  const unitRaw = qtyMatch?.[2] ?? 'шт';
  const unit = unitRaw === 'пар' ? 'пар' : unitRaw === 'пара' ? 'пара' : unitRaw === 'комплект' ? 'комплект' : 'шт.';
  if (text.includes('до износа')) return { qty, unit, wearKind: 'until_wearout', wearMonths: null, periodText: 'до износа' };
  if (text.includes('определяется документами изготовителя')) {
    return { qty, unit, wearKind: 'by_manufacturer', wearMonths: null, periodText: 'срок определяется документами изготовителя' };
  }
  if (yearsMatch) {
    const years = Number(yearsMatch[1]);
    return { qty, unit, wearKind: 'months', wearMonths: years * 12, periodText: `на ${years} ${years === 1 ? 'год' : 'года'}` };
  }
  const months = 12 % qty === 0 ? 12 / qty : Math.max(1, Math.round(12 / qty));
  return { qty, unit, wearKind: 'months', wearMonths: months, periodText: null };
}

// ── Номенклатура СИЗ: базовая позиция + размерный ряд ────────────────────────
// Размерный ряд — по виду средства защиты. Одежда, обувь, перчатки и головные
// уборы — размерные; остальное (очки, каски, респираторы) — нет.
const SIZE_RANGES = {
  clothes: ['44', '46', '48', '50', '52', '54', '56'],
  shoes: ['38', '39', '40', '41', '42', '43', '44', '45', '46'],
  gloves: ['S', 'M', 'L', 'XL', 'XXL'],
  headgear: ['54', '56', '58', '60', '62'],
};

function sizeKindFor(ppeType, name) {
  const t = normKey(ppeType);
  const n = normKey(name);
  if (/средства защиты рук/.test(t) || /перчат|нарукавник/.test(n)) return 'gloves';
  if (/средства защиты ног/.test(t) || /обув|сапог|ботин/.test(n)) return 'shoes';
  if (/средства защиты головы/.test(t) || /головной убор|подшлемник|каска/.test(n)) return 'headgear';
  if (/одежд/.test(t) || /костюм|куртк|брюк|комбинезон|халат|жилет|фартук|пальто|плащ|белье/.test(n)) return 'clothes';
  return null;
}

// Базовая позиция — по уникальному (тип, наименование) из приказа.
const baseMap = new Map();
for (const s of specs) {
  const key = `${normKey(s.ppeType)}|${normKey(s.name)}`;
  if (baseMap.has(key)) continue;
  const kind = sizeKindFor(s.ppeType, s.name);
  baseMap.set(key, {
    id: stableUuid(`nom-base:${key}`),
    name: s.name.replace(/\s+$/, ''),
    ppeType: s.ppeType,
    sizeKind: kind,
    code: `СИЗ-${String(baseMap.size + 1).padStart(3, '0')}`,
  });
}
const basePositions = [...baseMap.values()];

// Привязка строки приказа к базовой позиции номенклатуры: по паре (тип, наименование).
// Это и есть «маппинг приказ → позиция»: привязал один раз — карточка сама подставляет
// наименование, единицу, количество и пункт приложения.
const baseIdByKey = new Map();
for (const b of basePositions) baseIdByKey.set(`${normKey(b.ppeType)}|${normKey(b.name)}`, b.id);

const sizePositions = [];
for (const base of basePositions) {
  const range = base.sizeKind ? SIZE_RANGES[base.sizeKind] : null;
  if (!range) continue;
  for (const size of range) {
    sizePositions.push({
      id: stableUuid(`nom-size:${base.id}:${size}`),
      parentId: base.id,
      name: `${base.name}, р. ${size}`,
      code: `${base.code}-${size}`,
    });
  }
}

// ── Строки наборов норм ───────────────────────────────────────────────────────
// Строка набора (ppe_norm_lines) указывает на БАЗОВУЮ позицию номенклатуры, а не на
// размерную: размер сотрудника подставляется при выдаче (дерево «база → размеры»
// и подсказка по размеру в карточке). Иначе в норму каждой профессии пришлось бы
// заводить по строке на каждый размер — 191 строка превратилась бы в тысячи.
const normLines = [];
for (const set of normSets) {
  const setSpecs = specs.filter((s) => s.occupationCode === set.occupationCode && s.sourceKind === set.sourceKind);
  for (const s of setSpecs) {
    const baseId = baseIdByKey.get(`${normKey(s.ppeType)}|${normKey(s.name)}`);
    if (!baseId) continue;
    const parsed = parseNorm(s.sourceRef);
    normLines.push({
      id: stableUuid(`line:${set.id}:${s.id}`),
      normSetId: set.id,
      specId: s.id,
      nomenclatureId: baseId,
      qty: parsed.qty,
      unit: parsed.unit,
      wearKind: parsed.wearKind,
      wearMonths: parsed.wearMonths,
    });
  }
}

// ── TS-файл-источник ──────────────────────────────────────────────────────────
function tsArray(rows, indent = '  ') {
  return rows
    .map((row) => {
      const body = Object.entries(row)
        .map(([k, v]) => `${k}: ${v === null ? 'null' : typeof v === 'string' ? `'${v.replace(/'/g, "\\'")}'` : v}`)
        .join(', ');
      return `${indent}{ ${body} },`;
    })
    .join('\n');
}

const ts = `/**
 * Нормы приказа о СИЗ (Минтруд 767н, Приложение №1) — файл-источник.
 *
 * Сгенерирован из документа «РМЗ Приказ о СИЗ (приложения).doc», таблица
 * «Типовые отраслевые нормы выдачи СИЗ», помощником
 * \`backend-api/scripts/generate-ppe-order-data.mjs\`. Правки — в исходном
 * документе и в генераторе, руками здесь не правим.
 *
 * Строки приказа делятся по профессиям и по источнику:
 *  - «ton» — Типовые отраслевые нормы 767н (пункт приложения у профессии);
 *  - «order766» — приказ 766н Прил.4 (СИЗ от пониженных температур). По п. 19
 *    приказа выдаются сезонно, поэтому у профессии два набора норм: основной и
 *    зимний. В примере личной карточки кладовщика это видно прямо: 4 строки с
 *    «Пункт № 1511» и 2 строки с «№ 766н Прил.4».
 *
 * Норма приказа разбирается доменом (\`parseOrderNormQty\`): количество, единица
 * измерения и форма срока («на 2 года», «до износа», «срок определяется
 * документами изготовителя»). Здесь лежит РОВНО ТО, что в документе, — разбор
 * живёт в одном месте и не дублируется.
 */

/** Профессия приказа: код пункта приложения (или служебный код групп «персонал»). */
export type PpeOrderOccupation = {
  /** Стабильный id: из него строятся ссылки в миграции и скриптах. */
  id: string;
  /** Код пункта приложения: «1511», «783»; для групп «персонал» — tech-staff/admin-staff. */
  code: string;
  /** Наименование профессии как в приказе. */
  postTitle: string;
  /** 'ton' — Типовые отраслевые нормы; 'local' — группа без номера пункта. */
  tonKind: 'ton' | 'local';
  /** Подпись пункта для печати: «Пункт № 1511». */
  tonLabel: string | null;
  /** Год приказа. */
  tonYear: number | null;
};

/** Строка нормы приказа — до разбора: что написано в документе. */
export type PpeOrderSpec = {
  id: string;
  /** Код профессии из \`PPE_ORDER_OCCUPATIONS\`. */
  occupationCode: string;
  /** Источник строки: ЕТН 767н или приказ 766н (СИЗ от пониженных температур). */
  sourceKind: 'ton' | 'order766';
  /** Подпись источника для колонки «Пункт типовых отраслевых норм». */
  sourceLabel: string | null;
  /** Тип средства защиты: «Средства защиты рук». */
  ppeType: string;
  /** Наименование СИЗ по приказу. */
  name: string;
  /** Норма приказа как написана: «12 пар», «1 шт. на 2 года», «до износа». */
  sourceRef: string;
  /** Порядковый номер строки внутри (профессия, источник). */
  sortOrder: number;
  /** Пометка приказа к строке («При наружных работах»). */
  note: string | null;
};

/** Набор норм профессии: основной и зимний (766н). */
export type PpeOrderNormSet = {
  id: string;
  occupationCode: string;
  sourceKind: 'ton' | 'order766';
  sourceLabel: string | null;
  name: string;
  /** Сезон набора: зимние СИЗ выдаются по сезону (п. 19 приказа). */
  season: 'winter' | null;
};

/** Базовая позиция справочника СИЗ (без размера) — ей соответствует строка приказа. */
export type PpeOrderBasePosition = {
  id: string;
  name: string;
  ppeType: string;
  /** Вид размерного ряда: одежда, обувь, перчатки, головной убор; null — без размера. */
  sizeKind: 'clothes' | 'shoes' | 'gloves' | 'headgear' | null;
  code: string;
};

/** Позиция размерного ряда: отдельная номенклатура с родителем-базой. */
export type PpeOrderSizePosition = {
  id: string;
  parentId: string;
  name: string;
  code: string;
};

export const PPE_ORDER_OCCUPATIONS: readonly PpeOrderOccupation[] = [
${tsArray(occupations)}
];

export const PPE_ORDER_SPECS: readonly PpeOrderSpec[] = [
${tsArray(specs)}
];

export const PPE_ORDER_NORM_SETS: readonly PpeOrderNormSet[] = [
${tsArray(normSets)}
];

export const PPE_ORDER_BASE_POSITIONS: readonly PpeOrderBasePosition[] = [
${tsArray(basePositions)}
];

export const PPE_ORDER_SIZE_POSITIONS: readonly PpeOrderSizePosition[] = [
${tsArray(sizePositions)}
];
`;

const tsPath = new URL('../src/data/ppeOrderNorms767.ts', import.meta.url);
writeFileSync(tsPath, ts, 'utf8');

// ── SQL-сид ───────────────────────────────────────────────────────────────────
function sqlStr(v) {
  return v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}
const NOW = 1767225600000; // 2026-01-01T00:00:00Z — метка сида, не «сейчас».

const parts = [];
parts.push(`-- Сид приказа о СИЗ (Минтруд 767н, Приложение №1): профессии, строки норм,
-- наборы норм и справочник номенклатуры СИЗ.
--
-- Сгенерировано помощником \`backend-api/scripts/generate-ppe-order-data.mjs\` из
-- документа «РМЗ Приказ о СИЗ (приложения).doc»; источник правды по данным —
-- \`backend-api/src/data/ppeOrderNorms767.ts\` (если файлы разошлись — правьте
-- генератор и документ, а не этот SQL).
--
-- Идемпотентно: фиксированные UUID + ON CONFLICT DO NOTHING. Повторный прогон
-- безвреден. Норма приказа (количество, единица, форма срока) разбирается
-- доменом \`parseOrderNormQty\` и в SQL не дублируется — здесь лежит РОВНО ТО,
-- что написано в документе.`);

parts.push(`-- 1. Профессии приказа: код пункта приложения → наименование профессии.
INSERT INTO ppe_occupation_ref (id, code, post_title, ton_kind, ton_label, ton_year, is_active, created_at, updated_at, sync_status)
VALUES`);
parts.push(
  occupations
    .map(
      (o) =>
        `  (${sqlStr(o.id)}, ${sqlStr(o.code)}, ${sqlStr(o.postTitle)}, ${sqlStr(o.tonKind)}, ${sqlStr(o.tonLabel)}, ${o.tonYear ?? 'NULL'}, true, ${NOW}, ${NOW}, 'synced')`,
    )
    .join(',\n') + ';',
);
parts.push(`--> statement-breakpoint`);

parts.push(`-- 2. Строки нормы приказа («приказные» строки): наименование, тип СИЗ, норма
-- как написана в документе, привязка к профессии и источнику (ЕТН 767н или 766н).
INSERT INTO ppe_norm_line_specs (id, occupation_id, name, ppe_type, qty, unit, wear_kind, wear_months, sort_order, source_ref, source_kind, source_label, created_at, updated_at, sync_status)
VALUES`);
parts.push(
  specs
    .map((s) => {
      const occ = occupations.find((o) => o.code === s.occupationCode);
      // Количество/единица/срок разбираются доменом; здесь — годовая норма приказа
      // как есть, единица и срок выведены из неё правилами parseOrderNormQty.
      const qty = (() => {
        const m = s.sourceRef.match(/(\d+)/);
        return m ? Number(m[1]) : 1;
      })();
      const unit = s.sourceRef.includes('пар') ? 'пар' : s.sourceRef.includes('комплект') ? 'комплект' : 'шт.';
      const wearKind = s.sourceRef.includes('до износа')
        ? 'until_wearout'
        : s.sourceRef.includes('определяется документами изготовителя')
          ? 'by_manufacturer'
          : 'months';
      const years = s.sourceRef.match(/(\d+)\s*(?:лет|года|год)(?![а-яё])/);
      const wearMonths = wearKind === 'months' ? (years ? Number(years[1]) * 12 : 12 % qty === 0 ? 12 / qty : Math.max(1, Math.round(12 / qty))) : 'NULL';
      return `  (${sqlStr(s.id)}, ${sqlStr(occ.id)}, ${sqlStr(s.name)}, ${sqlStr(s.ppeType)}, ${qty}, ${sqlStr(unit)}, ${sqlStr(wearKind)}, ${wearMonths}, ${s.sortOrder}, ${sqlStr(s.sourceRef)}, ${sqlStr(s.sourceKind)}, ${sqlStr(s.sourceLabel)}, ${NOW}, ${NOW}, 'synced')`;
    })
    .join(',\n') + ';',
);
parts.push(`--> statement-breakpoint`);

parts.push(`-- 3. Наборы норм: по профессии и по источнику. Зимний набор (766н) помечен
-- season='winter' — по п. 19 приказа СИЗ от пониженных температур выдаются
-- сезонно, то есть ПОВЕРХ основной нормы, а не вместо неё.
INSERT INTO ppe_norm_sets (id, name, post_title, gender, season, is_duty, occupation_id, source_kind, source_label, valid_from, created_at, updated_at, sync_status)
VALUES`);
parts.push(
  normSets
    .map((s) => {
      const occ = occupations.find((o) => o.code === s.occupationCode);
      return `  (${sqlStr(s.id)}, ${sqlStr(s.name)}, ${sqlStr(occ.postTitle)}, NULL, ${s.season ? sqlStr(s.season) : 'NULL'}, false, ${sqlStr(occ.id)}, ${sqlStr(s.sourceKind)}, ${sqlStr(s.sourceLabel)}, ${NOW}, ${NOW}, ${NOW}, 'synced')`;
    })
    .join(',\n') + ';',
);
parts.push(`--> statement-breakpoint`);

parts.push(`-- 4. Строки наборов норм: привязка строки приказа к базовой позиции
-- номенклатуры и к «приказной» строке (spec_id). Размер сотрудника подставляется
-- при выдаче — дерево «база → размеры», поэтому в норме лежит базовая модель.
INSERT INTO ppe_norm_lines (id, norm_set_id, nomenclature_id, qty, wear_months, spec_id, unit, wear_kind, created_at, updated_at, sync_status)
VALUES`);
parts.push(
  normLines
    .map((l) => {
      const wear = l.wearMonths == null ? 'NULL' : l.wearMonths;
      return `  (${sqlStr(l.id)}, ${sqlStr(l.normSetId)}, ${sqlStr(l.nomenclatureId)}, ${l.qty}, ${wear}, ${sqlStr(l.specId)}, ${sqlStr(l.unit)}, ${sqlStr(l.wearKind)}, ${NOW}, ${NOW}, 'synced')`;
    })
    .join(',\n') + ';',
);
parts.push(`--> statement-breakpoint`);

parts.push(`-- 5. Привязка «приказная строка → базовая позиция номенклатуры». Это ключ
-- подстановки: привязал позицию один раз — карточка сама подставляет наименование,
-- единицу измерения, количество и пункт приложения.
UPDATE ppe_norm_line_specs s
   SET nomenclature_id = n.nomenclature_id
  FROM (
    SELECT spec_id, nomenclature_id FROM ppe_norm_lines
     WHERE deleted_at IS NULL AND spec_id IS NOT NULL
  ) n
 WHERE s.id = n.spec_id AND s.nomenclature_id IS NULL;`);

parts.push(`--> statement-breakpoint`);

parts.push(`-- 6. Номенклатура СИЗ: базовая позиция (без размера) и её размерный ряд.
-- Размер — отдельная позиция-вариант с родителем-базой (один уровень), как
-- заведено для остальной номенклатуры. Категория 'workwear' отделяет СИЗ от
-- деталей — в фонд деталей они не попадают.
INSERT INTO erp_nomenclature (id, code, name, item_type, category, parent_nomenclature_id, is_active, sync_status, created_at, updated_at)
VALUES`);
const nomRows = [
  ...basePositions.map(
    (b) =>
      `  (${sqlStr(b.id)}, ${sqlStr(b.code)}, ${sqlStr(b.name)}, 'material', 'workwear', NULL, true, 'synced', ${NOW}, ${NOW})`,
  ),
  ...sizePositions.map(
    (s) =>
      `  (${sqlStr(s.id)}, ${sqlStr(s.code)}, ${sqlStr(s.name)}, 'material', 'workwear', ${sqlStr(s.parentId)}, true, 'synced', ${NOW}, ${NOW})`,
  ),
];
parts.push(nomRows.join(',\n') + ';');
parts.push(`--> statement-breakpoint`);

const sqlPath = new URL('../drizzle/0118_ppe_order_norms_seed.sql', import.meta.url);
writeFileSync(sqlPath, `${parts.join('\n')}\n`, 'utf8');

console.log(
  `профессий ${occupations.length}, строк ${specs.length}, наборов ${normSets.length}, ` +
    `номенклатура ${basePositions.length}+${sizePositions.length}`,
);
