import { applyTxs, computeLedgerStateHashes, emptyLedgerState, type LedgerBlock, type LedgerState } from '@matricarmz/ledger';

// Чистая половина `ledger:rebuild-state` — разбор аргументов, порядок блоков, прогон и вердикт.
// Вынесена сюда по той же причине, что и у files:offload-to-yandex: ошибка в этой логике не
// падает, она молча выносит неверный вердикт о целостности леджера. Форма обязана быть под тестом.
//
// Почему инструмент вообще нужен: проекцию `state.json` НИКТО не умеет собрать из блоков —
// единственные писатели (`appendBlock`/`appendRemoteBlock`) делают read-modify-write, а
// восстановление при порче (`ensureLedgerStateFile`) берёт свежий `state.json.bak.*` либо пишет
// ПУСТОЕ состояние, блоки не читая. То есть сегодня проекция авторитетна де-факто, и любая её
// потеря необратима. Этот инструмент возвращает выводимость: состояние снова следствие цепочки.

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

// Единственная дыра в сквозной нумерации на 1,5 млн транзакций. Объяснена, но НЕ закрыта:
// семь транзакций от 06.03.2026 отсутствуют в цепочке, и по ledger их содержимое не восстановить.
export const KNOWN_SEQ_GAP = { fromSeq: 421759, toSeq: 421765, note: 'гонка дописывания 06.03.2026; блок проигравшего затёрт победителем' } as const;

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
    applyTxs(state, block.txs);
    blocks += 1;
    txs += block.txs.length;
    lastHeight = block.height;
    if (deps.onProgress && blocks % 5000 === 0) deps.onProgress({ blocks, txs, lastHeight });
    if (opts.maxBlocks && blocks >= opts.maxBlocks) break;
  }
  return { state, blocks, txs, lastHeight, gaps, bad, known };
}

export type Verdict = 'MATCH' | 'TABLE_SET_SKEW' | 'DATA_DIVERGENCE' | 'HEAD_MOVED';

export type CompareResult = {
  verdict: Verdict;
  stateHashEqual: boolean;
  onlyInRebuilt: string[];
  onlyInLive: string[];
  divergentTables: string[];
  emptyAsymmetric: boolean;
  detail: string;
};

function rowCount(state: LedgerState, table: string): number {
  const rows = (state.tables as Record<string, Record<string, unknown>>)[table];
  return rows ? Object.keys(rows).length : 0;
}

/**
 * Вердикт даётся по ПОТАБЛИЧНЫМ хешам, а `stateHash` — только сводка.
 *
 * Разница принципиальна: `stateHash` считается по отсортированному списку пар «имя таблицы →
 * хеш», поэтому он меняется от одного лишь появления НОВОГО ПУСТОГО ключа — например когда в
 * `emptyLedgerState()` добавили таблицу, а `state.json` с тех пор целиком не переписывался
 * (`loadState` не досыпает новые пустые таблицы в загруженный файл). Данные при этом совпадают
 * до байта. Инструмент, судящий по одному `stateHash`, кричал бы «повреждение» на здоровом
 * леджере — и его перестали бы слушать ровно к тому дню, когда повреждение случится всерьёз.
 *
 * Поэтому асимметрия по набору таблиц — отдельный вердикт, и только если КАЖДАЯ асимметричная
 * таблица пуста с обеих сторон. Непустая таблица, которой нет во втором состоянии, — это уже
 * расхождение данных, а не бухгалтерия.
 */
export function compareStates(rebuilt: LedgerState, live: LedgerState): CompareResult {
  const r = computeLedgerStateHashes(rebuilt);
  const l = computeLedgerStateHashes(live);
  const rTables = Object.keys(r.tableHashes).sort();
  const lTables = Object.keys(l.tableHashes).sort();
  const onlyInRebuilt = rTables.filter((t) => !lTables.includes(t));
  const onlyInLive = lTables.filter((t) => !rTables.includes(t));
  const shared = rTables.filter((t) => lTables.includes(t));
  const divergentTables = shared.filter((t) => r.tableHashes[t] !== l.tableHashes[t]);
  const asymmetric = [...onlyInRebuilt.map((t) => rowCount(rebuilt, t)), ...onlyInLive.map((t) => rowCount(live, t))];
  const emptyAsymmetric = asymmetric.every((n) => n === 0);
  const stateHashEqual = r.stateHash === l.stateHash;

  if (divergentTables.length > 0) {
    return {
      verdict: 'DATA_DIVERGENCE',
      stateHashEqual,
      onlyInRebuilt,
      onlyInLive,
      divergentTables,
      emptyAsymmetric,
      detail: `расходятся данные в таблицах: ${divergentTables.join(', ')}`,
    };
  }
  if (onlyInRebuilt.length === 0 && onlyInLive.length === 0) {
    return { verdict: 'MATCH', stateHashEqual, onlyInRebuilt, onlyInLive, divergentTables, emptyAsymmetric, detail: 'состояние выводится из цепочки блоков полностью' };
  }
  if (!emptyAsymmetric) {
    return {
      verdict: 'DATA_DIVERGENCE',
      stateHashEqual,
      onlyInRebuilt,
      onlyInLive,
      divergentTables,
      emptyAsymmetric,
      detail: `таблица есть только с одной стороны и НЕ пуста: ${[...onlyInRebuilt, ...onlyInLive].join(', ')}`,
    };
  }
  return {
    verdict: 'TABLE_SET_SKEW',
    stateHashEqual,
    onlyInRebuilt,
    onlyInLive,
    divergentTables,
    emptyAsymmetric,
    detail:
      `данные совпадают до байта, различается только набор пустых таблиц ` +
      `(только в пересборке: ${onlyInRebuilt.join(', ') || '—'}; только в state.json: ${onlyInLive.join(', ') || '—'}). ` +
      `Обычная причина — таблицу добавили в emptyLedgerState() позже, чем state.json последний раз переписывался целиком. Потери данных нет.`,
  };
}

export function exitCodeFor(verdict: Verdict): number {
  return verdict === 'MATCH' || verdict === 'TABLE_SET_SKEW' ? 0 : 1;
}
