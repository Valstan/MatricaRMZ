/**
 * Подбор приказной строки нормы под торговую позицию СИЗ.
 *
 * Промты КАРМАНА #20/#25: торговое имя и сертификат живут в должностной карточке
 * кладовщика, приказная строка — в приказе 767н. Связь строится по виду СИЗ и
 * смыслу названия.
 *
 * Две правки, которые делают подбор верным:
 *
 * 1. **Вид приказной строки берётся из её названия, если `ppe_type` не заполнен.**
 *    В сиде приказа вид проставлен не у всех строк («Перчатки для защиты от…»,
 *    «Каска защитная от…», «Обувь специальная диэлектрическая», «Перчатки
 *    специальные диэлектрические», «Фартук для защиты от искр…», «Каска защитная
 *    от повышенных температур» — `ppe_type` пусто). Такие строки выпадали из
 *    кандидатов, и вещь уходила в чужую норму: перчатки маляра привязывались к
 *    «Нарукавникам…», каска — к «Головному убору…».
 * 2. **Решения кладовщика — данные, а не разговор.** Спорные строки (две вещи
 *    претендуют на одну норму) решает человек; его ответ лежит в бланке выбора
 *    (`--choices=<csv>`) и применяется точно, без пересчёта. Решение «не
 *    привязывать» действует независимо от того, есть ли в приказе строка под
 *    видом СИЗ, а название строки, которой у профессии нет, уточняется подбором
 *    по торговому идентификатору («… — У-2К») — решение кладовщика при этом не
 *    теряется.
 *
 * Вид, к которому относится и торговое имя, и приказная строка, — один и тот же
 * словарь: ноги, руки, голова, глаза, дыхание, слух, колени, одежда, лицо.
 */

/** Вид СИЗ по торговому имени (в карточке вид не написан). */
const TRADE_KIND: Array<[string, string[]]> = [
  ['ноги', ['ботинки', 'сапоги', 'полуботинки', 'боты', 'башмаки']],
  ['руки', ['перчатки', 'краги', 'рукавицы', 'нарукавники']],
  ['голова', ['каска', 'кепка', 'подшлемник', 'берет']],
  ['глаза', ['очки']],
  ['дыхание', ['полумаска', 'респиратор', 'фильтр', 'маска']],
  ['слух', ['наушники', 'беруши']],
  ['колени', ['наколенник']],
  ['лицо', ['щиток']],
  ['одежда', ['костюм', 'куртка', 'плащ', 'пальто', 'халат', 'комбинезон', 'фартук', 'жилет']],
];

/**
 * Вид приказной строки по её названию — для строк, где `ppe_type` не заполнен.
 * Порядок важен: конкретное название («Каска защитная») проверяется раньше
 * родового («Головной убор»), иначе каска уехала бы в общую норму.
 */
const ORDER_KIND_BY_NAME: Array<[string, string[]]> = [
  ['ноги', ['обувь', 'ботинки', 'сапоги', 'полуботинки', 'боты', 'башмаки']],
  ['руки', ['перчатки', 'нарукавники', 'краги', 'рукавицы']],
  ['голова', ['головной убор', 'каска', 'кепка', 'подшлемник', 'берет']],
  ['глаза', ['очки']],
  ['дыхание', ['органов дыхания', 'полумаска', 'маска', 'респиратор', 'изолирующ', 'фильтрующ']],
  ['слух', ['противошумн', 'наушники', 'вкладыш', 'беруши']],
  ['колени', ['наколенник']],
  ['лицо', ['щиток', 'лицевой']],
  ['одежда', ['костюм', 'куртка', 'плащ', 'пальто', 'халат', 'фартук', 'жилет', 'белье', 'одежда']],
];

/** Слова, которые ничего не различают. */
const STOP_WORDS = new Set(['для', 'от', 'и', 'в', 'по', 'с', 'к', 'а']);

/** Значимые слова торгового имени: всё длиннее трёх букв, кроме служебных. */
export function significantWords(name: string): string[] {
  return String(name ?? '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
}

/** Предмет торгового имени — первое значимое слово: «перчатки», «нарукавники», «кепка». */
export function itemNoun(name: string): string | null {
  const first = String(name ?? '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .map((w) => w.trim())
    .find((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return first ?? null;
}

/** Вид по торговому имени. */
export function tradeKindOf(name: string): string | null {
  const text = String(name ?? '').toLowerCase();
  for (const [kind, words] of TRADE_KIND) {
    if (words.some((w) => text.includes(w))) return kind;
  }
  return null;
}

/** Вид по типу приказной строки (`ppe_type`). */
export function kindByOrderType(ppeType: string | null): string | null {
  const text = String(ppeType ?? '').toLowerCase();
  if (!text) return null;
  if (text.includes('ног')) return 'ноги';
  if (text.includes('рук')) return 'руки';
  if (text.includes('голов')) return 'голова';
  if (text.includes('глаз')) return 'глаза';
  if (text.includes('дыхани')) return 'дыхание';
  if (text.includes('слух')) return 'слух';
  if (text.includes('одежд')) return 'одежда';
  if (text.includes('лиц')) return 'лицо';
  return null;
}

/** Вид по названию приказной строки — запасной путь, когда `ppe_type` пусто. */
export function kindByOrderName(name: string): string | null {
  const text = String(name ?? '').toLowerCase();
  for (const [kind, words] of ORDER_KIND_BY_NAME) {
    if (words.some((w) => text.includes(w))) return kind;
  }
  return null;
}

/** Вид приказной строки: сначала тип, потом название. */
export function kindByOrder(ppeType: string | null, name: string): string | null {
  return kindByOrderType(ppeType) ?? kindByOrderName(name);
}

function scoreBy(tradeWords: string[], orderName: string): number {
  const text = String(orderName ?? '').toLowerCase();
  let score = 0;
  for (const w of tradeWords) if (text.includes(w)) score += 1;
  return score;
}

/** Торговый идентификатор в названии строки приказа: «… — У-2К» → «У-2К». */
export function orderIdentifier(name: string): string | null {
  const m = String(name ?? '').match(/\s+—\s+(.+)$/);
  return m ? m[1]!.trim() : null;
}

/** Название строки приказа без торгового идентификатора: «… — У-2К» → «…». */
export function baseOrderName(name: string): string {
  const text = String(name ?? '').trim();
  // Идентификатор может содержать дефис («СОЮЗ-2»), поэтому отбрасываем всё после
  // ПОСЛЕДНЕГО разделителя « — ».
  const m = text.match(/^(.+)\s+—\s+([^—]+)$/);
  return m ? m[1]!.trim() : text;
}

/**
 * Совпадение по торговому идентификатору: «Полумаска (У-2К)» → строка «… — У-2К».
 * Слов из идентификатора в подборе не видно («2К», «0113» — короткие), а по
 * идентификатору вещь узнаётся однозначно.
 *
 * Вес небольшой: идентификатор бывает у нескольких вещей сразу (перчатки и
 * нарукавники одной сертификации — «ЛАЙТ/BERD»), и решает не он, а предмет строки.
 */
function identifierBonus(tradeName: string, orderName: string): number {
  const id = orderIdentifier(orderName);
  if (!id) return 0;
  const trade = String(tradeName ?? '').toLowerCase();
  const ident = id.toLowerCase();
  return ident.length >= 3 && trade.includes(ident) ? 2 : 0;
}

/**
 * Очки кандидата: совпавшие слова + бонус за торговый идентификатор − штраф за
 * чужой предмет.
 *
 * Штраф: перчатки не ложатся в строку про нарукавники, костюм — в строку про
 * плащ. Общий «Головной убор» — единственное исключение: кепка, каска и
 * подшлемник по карточкам завода идут именно в него.
 */
function scoreCandidate(tradeName: string, tradeWords: string[], orderName: string): number {
  let score = scoreBy(tradeWords, orderName) + identifierBonus(tradeName, orderName);
  const noun = itemNoun(tradeName);
  if (noun) {
    const row = String(orderName ?? '').toLowerCase();
    // Общий «Головной убор» приказа — единственное исключение: кепка, каска и
    // подшлемник по карточкам завода идут именно в него. Строка с торговым
    // идентификатором («… — кепка СОЮЗ-2») — не общий слот, а своя норма.
    const generic = row.startsWith('головной убор') && !orderIdentifier(orderName);
    if (!generic && !row.includes(noun)) score -= 5;
  }
  return score;
}

export type SpecRow = {
  id: string;
  occupationCode: string;
  name: string;
  ppeType: string | null;
  sourceKind: string;
  sortOrder: number;
};

export type TradePosition = {
  occupationCode: string;
  name: string;
  certificate: string | null;
};

/** Решение кладовщика: эта торговая позиция — эта приказная строка. */
export type TradeChoice = {
  occupationCode: string;
  tradeName: string;
  orderName: string;
  /** Позиция остаётся без своей нормы (решение кладовщика). */
  skip?: boolean;
};

export type LinkStatus = 'связано' | 'неоднозначно' | 'не найдено' | 'лишняя';

export type LinkRow = {
  occupationCode: string;
  tradeName: string;
  certificate: string | null;
  specId: string | null;
  orderName: string | null;
  kind: string | null;
  score: number | null;
  status: LinkStatus;
  candidates: string[];
  note?: string;
};

/** Ключ решения: профессия + торговое имя. */
export function choiceKey(occupationCode: string, tradeName: string): string {
  return `${occupationCode}|${tradeName}`;
}

/**
 * Собирает план связей.
 *
 * @param specs приказные строки наборов норм
 * @param positions торговые позиции из справочника должностных карточек
 * @param choices решения кладовщика (ключ — профессия + торговое имя)
 * @param onlySpecId ограничение на одну приказную строку (для точечного прогона)
 */
export function linkTradePositions(
  specs: SpecRow[],
  positions: readonly TradePosition[],
  choices: TradeChoice[] = [],
  onlySpecId: string | null = null,
): LinkRow[] {
  const choiceByKey = new Map(choices.map((c) => [choiceKey(c.occupationCode, c.tradeName), c]));
  const plan: LinkRow[] = [];

  for (const trade of positions) {
    const words = significantWords(trade.name);
    const kind = tradeKindOf(trade.name);
    let pool = specs.filter((s) => s.occupationCode === trade.occupationCode);
    if (onlySpecId) pool = pool.filter((s) => s.id === onlySpecId);

    const chosen = choiceByKey.get(choiceKey(trade.occupationCode, trade.name));

    // Решение кладовщика «не привязывать» — выше подбора: оно не зависит от того,
    // есть ли в приказе строка под вид СИЗ. Решение владельца 17.11.2026 про
    // наколенники и закрытые очки сварщика — таких строк в приказе нет ни у кого,
    // и раньше оно терялось: подбор успевал объявить позицию «не найдено».
    if (chosen?.skip) {
      plan.push({
        occupationCode: trade.occupationCode,
        tradeName: trade.name,
        certificate: trade.certificate,
        specId: null,
        orderName: null,
        kind,
        score: null,
        status: 'лишняя',
        candidates: [],
        note: 'решение кладовщика: не привязывать',
      });
      continue;
    }

    if (kind) {
      const byKind = pool.filter((s) => kindByOrder(s.ppeType, s.name) === kind);
      // Вид известен, но в приказе у профессии такой строки нет — это не «неоднозначно»,
      // а «нет пары»: в приказе этого СИЗ для профессии не предусмотрено.
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
          ...(chosen
            ? { note: `выбор кладовщика «${chosen.orderName}»: в приказе нет строки под вид «${kind}» — нужна своя норма` }
            : {}),
        });
        continue;
      }
      pool = byKind;
    }

    // Зимние (766н) в карточках не описаны — при наличии основной нормы они вне кандидатов.
    const nonWinter = pool.filter((s) => s.sourceKind !== 'order766');
    if (nonWinter.length > 0) pool = nonWinter;

    if (pool.length === 0) {
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

    // Решение кладовщика — точное попадание в норму, подбор не участвует.
    if (chosen) {
      const target =
        pool.find((s) => s.name === chosen.orderName) ??
        specs.find((s) => s.name === chosen.orderName && s.occupationCode === trade.occupationCode);
      if (target) {
        plan.push({
          occupationCode: trade.occupationCode,
          tradeName: trade.name,
          certificate: trade.certificate,
          specId: target.id,
          orderName: target.name,
          kind,
          score: scoreBy(words, target.name),
          status: 'связано',
          candidates: [],
          note: 'выбор кладовщика',
        });
        continue;
      }
      // Названия строки из бланка у профессии нет: бланк заполняли по другой должности
      // или текст строки поменялся. Решение кладовщика терять нельзя — ищем строку с
      // тем же названием без торгового идентификатора, а если такой нет — по подбору.
      const base = baseOrderName(chosen.orderName);
      const byBase = pool.filter((s) => baseOrderName(s.name) === base);
      const cands = byBase.length > 0 ? byBase : pool;
      const withId = cands.filter((s) => identifierBonus(trade.name, s.name) > 0);
      const finalists = withId.length > 0 ? withId : cands;
      const scored = finalists
        .map((s) => ({ s, score: scoreCandidate(trade.name, words, s.name) }))
        .sort((a, b) => b.score - a.score || a.s.sortOrder - b.s.sortOrder);
      const best = scored[0]!;
      const second = scored[1];
      if (finalists.length === 1 || (second && best.score > second.score)) {
        plan.push({
          occupationCode: trade.occupationCode,
          tradeName: trade.name,
          certificate: trade.certificate,
          specId: best.s.id,
          orderName: best.s.name,
          kind,
          score: best.score,
          status: 'связано',
          candidates: [],
          note: `выбор кладовщика («${chosen.orderName}») — строка уточнена по подбору`,
        });
        continue;
      }
      plan.push({
        occupationCode: trade.occupationCode,
        tradeName: trade.name,
        certificate: trade.certificate,
        specId: null,
        orderName: null,
        kind,
        score: null,
        status: 'неоднозначно',
        candidates: scored.slice(0, 5).map((x) => `${x.s.name} (очки ${x.score})`),
        note: `выбор кладовщика «${chosen.orderName}»: такой строки приказа у профессии нет, подбор неоднозначен`,
      });
      continue;
    }

    const scored = pool
      .map((s) => ({ s, score: scoreCandidate(trade.name, words, s.name) }))
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

  // Конфликт: две торговые позиции претендуют на одну приказную строку. Так бывает,
  // когда в карточке несколько предметов одного вида, а в приказе строка одна.
  // Затирать друг друга нельзя — обе позиции потеряют данные.
  const claims = new Map<string, LinkRow[]>();
  for (const p of plan) {
    if (!p.specId) continue;
    const list = claims.get(p.specId) ?? [];
    list.push(p);
    claims.set(p.specId, list);
  }
  for (const rows of claims.values()) {
    if (rows.length < 2) continue;
    const chosen = rows.filter((r) => r.note === 'выбор кладовщика');
    if (chosen.length === 1) {
      // Слот занят решением кладовщика — остальные позиции без своей нормы.
      for (const r of rows) {
        if (r === chosen[0]) continue;
        r.status = 'лишняя';
        r.specId = null;
        r.note = `в приказе одна строка, и она занята выбором кладовщика («${chosen[0]?.tradeName}»)`;
      }
      continue;
    }
    for (const r of rows) {
      r.status = 'неоднозначно';
      r.specId = null;
      r.candidates = [
        ...new Set([...r.candidates, ...rows.map((x) => `${x.tradeName} (та же приказная строка)`)]),
      ];
    }
  }

  return plan;
}

/**
 * Разбирает бланк выбора кладовщика (CSV): строки раздела «спорная норма» с
 * заполненной колонкой «выбор кладовщика» — это готовые решения.
 *
 * Колонки: раздел, №, профессия, должность, приказная строка (норма),
 * вариант 1..3, выбор кладовщика, примечание.
 */
export function parseChoicesCsv(text: string): TradeChoice[] {
  const rows = parseCsv(text);
  const head = rows[0] ?? [];
  const idx = (name: string) => head.findIndex((h) => h.trim().toLowerCase() === name);
  const iSection = idx('раздел');
  const iProf = idx('профессия');
  const iOrder = idx('приказная строка (норма)');
  const iPick = idx('выбор кладовщика');
  if (iProf < 0 || iOrder < 0 || iPick < 0) return [];
  const out: TradeChoice[] = [];
  for (const r of rows.slice(1)) {
    if (!r || r.length <= iPick) continue;
    const section = iSection >= 0 ? String(r[iSection] ?? '').trim() : '';
    const tradeName = String(r[iPick] ?? '').trim();
    const orderName = String(r[iOrder] ?? '').trim();
    if (!tradeName) continue;
    // «Не привязывать»: позиция остаётся без своей нормы — решение кладовщика.
    if (section === 'не привязывать') {
      out.push({ occupationCode: String(r[iProf] ?? '').trim(), tradeName, orderName: '', skip: true });
      continue;
    }
    if (section !== 'спорная норма') continue;
    if (!orderName || tradeName === 'Не привязывать') continue;
    out.push({ occupationCode: String(r[iProf] ?? '').trim(), tradeName, orderName });
  }
  return out;
}

/** Минимальный разбор CSV (кавычки, запятые в кавычках). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}
