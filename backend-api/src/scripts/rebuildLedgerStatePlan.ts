import { applyTxs, emptyLedgerState, type LedgerBlock, type LedgerState } from '@matricarmz/ledger';

// Чистая половина `ledger:rebuild-state` — разбор аргументов, порядок блоков, прогон и вердикт.
// Вынесена сюда по той же причине, что и у files:offload-to-yandex: ошибка в этой логике не
// падает, она молча выносит неверный вердикт о целостности леджера. Форма обязана быть под тестом.
//
// Что инструмент проверяет — и чего НЕ проверяет (вариант А, решение владельца 2026-09-05).
// Цепочка блоков — журнал, а не истина: она держит блок-призрак (транзакции, которые нигде не
// применились, M104) и не знает о записях в PostgreSQL мимо ledger'а. Поэтому «состояние
// выводится из цепочки» больше не критерий, и сверять пересборку с `state.json` по хешам
// нельзя: она разойдётся на здоровом леджере. Здесь выносится вердикт только о САМОЙ цепочке —
// читаются ли все блоки, нет ли разрывов высоты, какие высоты объяснены. Сверка того, что
// цепочка знает, с истиной (PG) идёт по открытому тексту в `ledger:resnapshot-state
// --chain-rebuilt <файл --out>`: у него есть и PG, и keyring, а у этого инструмента — нарочно ни
// того, ни другого.

export type RebuildArgs = { outPath: string; maxBlocks: number; toHeight: number };

export function parseRebuildArgs(argv: string[]): RebuildArgs {
  const out: RebuildArgs = { outPath: '', maxBlocks: 0, toHeight: 0 };
  // `pnpm run … -- --flag` пробрасывает сам `--`; это разделитель, а не аргумент.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--out' || a === '--max-blocks' || a === '--to-height') {
      const raw = args[i + 1];
      if (raw === undefined || raw === '') throw new Error(`${a}: ожидается значение`);
      if (a === '--out') {
        out.outPath = raw;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) throw new Error(`${a}: ожидается целое неотрицательное число, получено "${raw}"`);
        if (a === '--max-blocks') out.maxBlocks = n;
        else out.toHeight = n;
      }
      i += 1;
      continue;
    }
    throw new Error(`неизвестный аргумент: ${a}`);
  }
  return out;
}

// Блоки лежат как `00000001.json` (padStart(8) в store.ts). Сортировать по ИМЕНИ нельзя: на
// высоте 100000000 padding кончается и лексикографический порядок расходится с числовым.
// Заодно отсекаем `<файл>.tmp-<pid>-<n>` — их оставляет writeFileAtomic на время записи, и
// читатель обязан их игнорировать ровно как это делает прод (фильтр `.endsWith('.json')`).
export function isBlockFileName(name: string): boolean {
  return name.endsWith('.json') && !/\.tmp-\d+-\d+$/.test(name) && /^\d+\.json$/.test(name);
}

export function heightFromBlockFileName(name: string): number | null {
  const m = /^(\d+)\.json$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

// Порядок — по числовой высоте из имени, а не по строке. Имя тут единственный дешёвый источник:
// читать 396 тыс. файлов только ради поля `height` значило бы пройти каталог дважды.
export function orderedBlockFiles(names: readonly string[]): string[] {
  return names
    .filter(isBlockFileName)
    .map((name) => ({ name, height: heightFromBlockFileName(name) ?? 0 }))
    .sort((a, b) => a.height - b.height)
    .map((x) => x.name);
}

/**
 * Разрешено ли писать результат по этому пути.
 *
 * Живёт здесь, а не рядом с вводом-выводом, ровно потому, что это отказ, а отказы надо проверять
 * поведением. Внутрь каталога леджера писать нельзя по двум независимым причинам, и обе не видны
 * из кода самого инструмента: (1) что угодно в корне леджера уезжает в ночной шифрованный бэкап
 * и учитывается в его предполётной проверке места; (2) имя с префиксом `state.json.bak.`
 * подхватывается `ensureLedgerStateFile` как КАНДИДАТ НА ВОССТАНОВЛЕНИЕ — то есть наш отчёт
 * стал бы живым состоянием при ближайшей порче.
 *
 * `relative` возвращает путь без `..` только когда цель внутри базы; на Windows у путей с разных
 * дисков он вернёт абсолютный путь с буквой — это тоже «снаружи».
 */
export function outputPathAllowed(outAbs: string, ledgerDirAbs: string, relativeFn: (from: string, to: string) => string): boolean {
  const rel = relativeFn(ledgerDirAbs, outAbs);
  if (rel === '') return false;
  if (/^[A-Za-z]:/.test(rel)) return true;
  return rel.startsWith('..');
}

/**
 * Расхождения хеша, объяснённые ревизией 04.09.2026 и потому НЕ считающиеся находкой.
 *
 * Все три — след гонки двух одновременных дописываний (закрыта `withLock` + `writeFileAtomic`;
 * свежих случаев нет). Файл был переписан на месте другим блоком той же высоты, и преемник
 * ссылается на хеш, которого на диске больше нет. **Транзакции при этом не потеряны:** их `seq`
 * встречаются в цепочке ровно по одному разу и без дыры рядом, то есть оба соперника писали одну
 * и ту же транзакцию, разойдясь только полем `created_at`.
 *
 * Мусорные хвосты усечены на проде 04.09 (копии — `~/ledger-fix-backup-20260904/`), поэтому файлы
 * снова разбираются. Ссылку преемника усечение не чинит и не могло: прежнего блока нет ни у кого.
 *
 * Список нужен, чтобы проверка целостности не поднимала тревогу на одном и том же месте вечно.
 * Разбор — `docs/PENDING_FOLLOWUPS.md` §«Ревизия цепочки ledger».
 */
export const KNOWN_HASH_MISMATCH_HEIGHTS: Readonly<Record<number, string>> = {
  211728: 'гонка дописывания 09.04.2026; транзакция seq 558130 на месте, потери нет',
  237585: 'гонка дописывания 15.04.2026; транзакция seq 595444 на месте, потери нет',
  237605: 'гонка дописывания 15.04.2026; транзакция seq 595464 на месте, потери нет',
};

// Единственная дыра в сквозной нумерации на 1,5 млн транзакций. Семь транзакций от 06.03.2026
// отсутствуют в цепочке; по ledger их содержимое не восстановить. Сверка с PG 04.09: все семь строк
// в базе есть (last_server_seq одной из них = 421765), шесть позже повторно записаны в цепочку;
// у операции c272c9a7 записи создания в цепочке нет — это единственное ожидаемое расхождение от дыры.
export const KNOWN_SEQ_GAP = {
  fromSeq: 421759,
  toSeq: 421765,
  note: 'гонка дописывания 06.03.2026; блок проигравшего затёрт победителем; строки сверены с PG 04.09 — в базе есть, в цепочке нет',
} as const;

/**
 * Блоки-призраки: записаны в цепочку, но их транзакции нигде не состоялись (M104).
 *
 * `appendBlock` публикует файл блока и индекс РАНЬШЕ проекции и раньше PG; обрыв между ними
 * оставляет блок, чьи транзакции не применились ни в `state.json`, ни в PostgreSQL, ни в
 * `ledger_tx_index`. Клиент получает ошибку и повторяет push другими seq — удачная попытка лежит
 * в цепочке дальше. Пересборка такой блок обязана ПРОПУСТИТЬ: применив его, она воскресит строки,
 * которых рабочее хранилище не принимало.
 *
 * Запись сюда — только после проверки всех row_id блока по PG. Для 386592 проверено 05.09.2026:
 * из 1000 строк 767 в PG нет, 190 есть в версии старше блока, 43 — обновлены клиентом позже
 * с другими seq; ни у одной строки PG `updated_at` не равен метке транзакции блока.
 * Разбор — `docs/GOTCHAS.md` M104, `docs/PENDING_FOLLOWUPS.md` §«Второй прогон rebuild-state».
 */
export const KNOWN_GHOST_BLOCKS: Readonly<Record<number, string>> = {
  386592: 'блок-призрак 13.08.2026 (M104): seq 1360011…1361010, 1000 attribute_values, нигде не применились — пропущен; все 1000 row_id сверены с PG 05.09.2026',
};

export type ReplayProgress = { blocks: number; txs: number; lastHeight: number };

export type ReplayDeps = {
  listBlockFiles(): readonly string[];
  readBlock(name: string): LedgerBlock;
  onProgress?(p: ReplayProgress): void;
};

export type BadBlock = { name: string; reason: string };

export type ReplayResult = {
  state: LedgerState;
  blocks: number;
  txs: number;
  lastHeight: number;
  gaps: number[];
  bad: BadBlock[];
  known: Array<{ height: number; note: string }>;
  ghosts: Array<{ height: number; txs: number; note: string }>;
};

/**
 * Один упорядоченный проход по блокам. Никаких listBlocksSince/listTxsSince: обе читают каталог
 * целиком и заново с первого блока на КАЖДЫЙ вызов, то есть в цикле дают квадратичное чтение.
 *
 * Аккумулятор заводится через emptyLedgerState(), а не `{tables:{}}`: пустые таблицы участвуют в
 * хеше наравне с непустыми, и состояние, собранное из голого объекта, разойдётся с продовым по
 * набору ключей при полном совпадении данных.
 */
export function replayBlocks(deps: ReplayDeps, opts: { maxBlocks?: number; toHeight?: number } = {}): ReplayResult {
  const state = emptyLedgerState();
  const files = orderedBlockFiles(deps.listBlockFiles());
  const gaps: number[] = [];
  const bad: BadBlock[] = [];
  const known: Array<{ height: number; note: string }> = [];
  const ghosts: Array<{ height: number; txs: number; note: string }> = [];
  let blocks = 0;
  let txs = 0;
  let lastHeight = 0;
  for (const name of files) {
    const height = heightFromBlockFileName(name) ?? 0;
    if (opts.toHeight && height > opts.toHeight) break;
    // Нечитаемый блок ОБЯЗАН назвать себя. Первая версия падала наружу голым
    // «Unexpected non-whitespace character after JSON at position 1186» — без имени файла, без
    // высоты, после нескольких минут работы. Инструмент, который находит порчу и не говорит где,
    // заставляет искать её вручную среди 396 тыс. файлов. Поймано на первом прогоне на проде.
    let block: LedgerBlock;
    try {
      block = deps.readBlock(name);
    } catch (e) {
      bad.push({ name, reason: String((e as Error)?.message ?? e) });
      continue;
    }
    // Разрыв высоты — не повод молча продолжить: цепочка на то и цепочка. Считаем и докладываем,
    // потому что пропущенный блок означает, что собранное состояние заведомо неполно.
    if (lastHeight !== 0 && block.height !== lastHeight + 1) gaps.push(block.height);
    if (KNOWN_HASH_MISMATCH_HEIGHTS[block.height]) known.push({ height: block.height, note: KNOWN_HASH_MISMATCH_HEIGHTS[block.height] as string });
    // Блок-призрак читается и считается пройденным (высота, разрывы), но в состояние НЕ
    // применяется: его транзакции нигде не состоялись, и пересборка, взявшая их, воскресила бы
    // строки, которых нет в истине.
    const ghostNote = KNOWN_GHOST_BLOCKS[block.height];
    if (ghostNote) {
      ghosts.push({ height: block.height, txs: block.txs.length, note: ghostNote });
    } else {
      applyTxs(state, block.txs);
      txs += block.txs.length;
    }
    blocks += 1;
    lastHeight = block.height;
    if (deps.onProgress && blocks % 5000 === 0) deps.onProgress({ blocks, txs, lastHeight });
    if (opts.maxBlocks && blocks >= opts.maxBlocks) break;
  }
  return { state, blocks, txs, lastHeight, gaps, bad, known, ghosts };
}

export type ChainVerdict = 'CHAIN_READABLE' | 'CHAIN_INCOMPLETE';

/**
 * Вердикт — о цепочке как о журнале, не о данных.
 *
 * `CHAIN_READABLE`: каждый блок разобран, высоты идут без разрывов; объяснённые высоты и
 * блоки-призраки пройдены и названы. Это НЕ значит «состояние совпадает с истиной» — за это
 * отвечает сверка с PG в `resnapshot-state --chain-rebuilt`.
 * `CHAIN_INCOMPLETE`: есть нечитаемые блоки или разрывы высоты; собранное состояние заведомо
 * неполно, и сравнивать его с чем бы то ни было бессмысленно — сначала разобрать файлы.
 */
export function chainVerdict(replay: Pick<ReplayResult, 'bad' | 'gaps'>): { verdict: ChainVerdict; detail: string } {
  const parts: string[] = [];
  if (replay.bad.length > 0) parts.push(`нечитаемых блоков: ${replay.bad.length}`);
  if (replay.gaps.length > 0) parts.push(`разрывов высоты: ${replay.gaps.length}`);
  if (parts.length > 0) return { verdict: 'CHAIN_INCOMPLETE', detail: `${parts.join(', ')} — собранное состояние неполно, сначала разобрать файлы` };
  return { verdict: 'CHAIN_READABLE', detail: 'все блоки читаются, высоты без разрывов; сверка с истиной — resnapshot-state --chain-rebuilt' };
}

export function exitCodeFor(verdict: ChainVerdict): number {
  return verdict === 'CHAIN_READABLE' ? 0 : 1;
}
