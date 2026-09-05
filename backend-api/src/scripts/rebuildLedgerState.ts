import 'dotenv/config';

import { closeSync, existsSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, fsyncSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { LedgerBlock } from '@matricarmz/ledger';

import {
  chainVerdict,
  exitCodeFor,
  outputPathAllowed,
  parseRebuildArgs,
  replayBlocks,
  type ReplayDeps,
} from './rebuildLedgerStatePlan.js';

// ledger:rebuild-state — проходит цепочку блоков целиком, собирает из неё состояние в --out и
// выносит вердикт о ЦЕПОЧКЕ: читается ли каждый блок, нет ли разрывов высоты.
//
// ЗАЧЕМ. Цепочка — журнал, а не истина (вариант А, решение владельца 2026-09-05): она держит
// блок-призрак (M104 — транзакции, которые нигде не применились) и не знает о записях в PG мимо
// ledger'а. Поэтому инструмент больше НЕ сверяет пересборку с `state.json`: по шифротексту это
// давало тысячи ложных расхождений (случайный IV, эпохи ключа), а по смыслу «состояние
// выводится из цепочки» перестало быть критерием. Что цепочка знает и чего не знает истина —
// показывает `ledger:resnapshot-state -- --chain-rebuilt <файл --out>`, по открытому тексту.
// Здесь остаётся то, что можно проверить без PG и без ключа: целостность самой цепочки.
// Блоки-призраки (`KNOWN_GHOST_BLOCKS`) читаются, называются и в состояние не применяются.
//
// ЧЕГО ОН НЕ ДЕЛАЕТ — и это структурно, а не на словах. В файле НЕТ пути записи внутрь каталога
// леджера: единственная запись идёт в `--out`, и путь внутри LEDGER_DIR отвергается до чтения
// хотя бы одного блока. Причина конкретная: (1) имя с префиксом `state.json.bak.` делает файл
// КАНДИДАТОМ НА АВТОВОССТАНОВЛЕНИЕ — `ensureLedgerStateFile` подхватит свежайший такой файл и
// назначит его живым состоянием; (2) что угодно в корне леджера уезжает в ночной шифрованный
// бэкап и учитывается в его предполётной проверке места, а на боксе свободно ~9 ГБ при
// состоянии в 194 МБ. Ни одна из этих ловушек не видна из кода самого инструмента — только
// из соседних. Сторож формы — `rebuildLedgerStatePlan.test.ts`.
//
// ПАМЯТЬ. Бокс: 4096 МБ, лимит кучи Node по умолчанию 2096 МБ, состояние 194 МБ текстом и
// кратно больше как объект. Инструмент печатает пиковый RSS; если упирается — поднимать
// `NODE_OPTIONS=--max-old-space-size=3072`. Живой сервер держит тот же объём на каждый append,
// так что новых требований к боксу инструмент не создаёт.
//
// ЗАПУСК (только чтение, ничего не меняет):
//   corepack pnpm -F @matricarmz/backend-api ledger:rebuild-state
//   corepack pnpm -F @matricarmz/backend-api ledger:rebuild-state -- --out /tmp/rebuilt.json
//   corepack pnpm -F @matricarmz/backend-api ledger:rebuild-state -- --to-height 100
//   затем: corepack pnpm -F @matricarmz/backend-api ledger:resnapshot-state -- --chain-rebuilt /tmp/rebuilt.json
//
// КОДЫ ВОЗВРАТА: 0 — цепочка читается целиком (CHAIN_READABLE);
//                1 — нечитаемые блоки или разрывы высоты (CHAIN_INCOMPLETE); 2 — отказ до начала работы.

const INDEX_FILE = 'index.json';

function ledgerDir(): string {
  // Так же, как сервер (`resolveLedgerDir`), но БЕЗ mkdir и без импорта ledgerService: тот тянет
  // db.ts и, главное, `getLedgerStore()` — это мутация, а не чтение (он чинит state.json на месте).
  const raw = (process.env.MATRICA_LEDGER_DIR ?? '').trim();
  if (!raw) throw new Error('MATRICA_LEDGER_DIR не задан. Инструмент не угадывает каталог леджера: промах означал бы вердикт о чужих данных.');
  const dir = resolve(raw);
  if (!existsSync(dir)) throw new Error(`каталог леджера не найден: ${dir}`);
  return dir;
}

// Отказ структурный: любой путь внутри каталога леджера отвергается до чтения блоков.
// Само правило — в чистой половине (`outputPathAllowed`), там оно под тестом с реальными путями.
function assertOutsideLedger(outPath: string, dir: string): void {
  if (!outputPathAllowed(resolve(outPath), dir, relative)) {
    throw new Error(
      `--out указывает внутрь каталога леджера (${outPath}). Запрещено: файл в корне леджера уезжает в ночной бэкап и учитывается ` +
        `в его предполётной проверке места, а имя с префиксом резервной копии состояния подхватывается автовосстановлением как живое ` +
        `состояние. Выберите путь снаружи каталога леджера.`,
    );
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function headHeight(dir: string): number {
  const p = join(dir, INDEX_FILE);
  if (!existsSync(p)) return 0;
  return Number(readJson<{ lastHeight?: number }>(p).lastHeight ?? 0);
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

function peakRssMb(): string {
  return mb(process.memoryUsage().rss);
}

// Публикуем результат атомарно и в форме, которую НЕЛЬЗЯ спутать с LedgerState: у неё свой
// конверт с `kind`, а таблицы лежат внутри `state`. Рваный или случайно подобранный файл не
// пройдёт за состояние ни у одного читателя.
function publishAtomic(outPath: string, payload: unknown): void {
  const tmp = `${outPath}.partial-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify(payload));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, outPath);
}

function main(): void {
  const args = parseRebuildArgs(process.argv.slice(2));
  const dir = ledgerDir();
  const outPath = resolve(args.outPath || join(process.cwd(), 'ledger-rebuilt-state.json'));
  assertOutsideLedger(outPath, dir);
  if (!existsSync(dirname(outPath))) throw new Error(`каталог для --out не существует: ${dirname(outPath)}`);

  const blocksDir = join(dir, 'blocks');
  if (!existsSync(blocksDir)) throw new Error(`нет каталога блоков: ${blocksDir}`);

  console.log(`ledger:rebuild-state — только чтение, ничего не меняет`);
  console.log(`  каталог леджера: ${dir}`);
  console.log(`  вывод:           ${outPath}`);

  // Высоту фиксируем ДО прохода и печатаем ПОСЛЕ. Сервис живой: если за время чтения приехали
  // новые блоки, собранное состояние отстаёт от head на законных основаниях — читателю --out
  // (resnapshot-state) важно знать, до какой высоты оно собрано. Замок при этом не держим:
  // проход идёт минуты, а он рассчитан на операции в 15 секунд — держать его так долго значит
  // останавливать приём данных с цеха. Атомарная запись гарантирует, что рваного файла мы не прочтём.
  const headBefore = headHeight(dir);
  const started = process.hrtime.bigint();

  const deps: ReplayDeps = {
    listBlockFiles: () => readdirSync(blocksDir),
    readBlock: (name) => readJson<LedgerBlock>(join(blocksDir, name)),
    onProgress: (p) => console.log(`  … блоков ${p.blocks}, транзакций ${p.txs}, высота ${p.lastHeight}, RSS ${peakRssMb()} МБ`),
  };

  const opts: { maxBlocks?: number; toHeight?: number } = {};
  if (args.maxBlocks) opts.maxBlocks = args.maxBlocks;
  if (args.toHeight) opts.toHeight = args.toHeight;
  const replay = replayBlocks(deps, opts);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  console.log(
    `прогон: блоков ${replay.blocks}, транзакций ${replay.txs}, высота ${replay.lastHeight}, ` +
      `${(elapsedMs / 1000).toFixed(1)} с, пик RSS ${peakRssMb()} МБ`,
  );
  if (replay.gaps.length > 0) {
    console.log(`ВНИМАНИЕ: разрывы высоты (${replay.gaps.length}), первые: ${replay.gaps.slice(0, 5).join(', ')} — собранное состояние заведомо неполно`);
  }
  // Нечитаемые блоки — не повод молча выдать вердикт: их транзакции в состояние не попали,
  // и любое сравнение после этого заведомо неполно. Называем каждый по имени и отказываемся судить.
  // Объяснённые расхождения печатаем отдельно и НЕ как находку: иначе каждая проверка целостности
  // поднимает тревогу на одном и том же месте, и её перестают читать.
  if (replay.known.length > 0) {
    console.log(`известных расхождений пройдено: ${replay.known.length} (ревизия 04.09.2026, не находка)`);
    for (const k of replay.known) console.log(`  высота ${k.height}: ${k.note}`);
  }
  if (replay.ghosts.length > 0) {
    console.log(`блоков-призраков пропущено: ${replay.ghosts.length} (M104, в состояние не применены)`);
    for (const g of replay.ghosts) console.log(`  высота ${g.height} (${g.txs} тр.): ${g.note}`);
  }
  if (replay.bad.length > 0) {
    console.log(`НЕЧИТАЕМЫХ БЛОКОВ: ${replay.bad.length} — их транзакции в пересборку НЕ вошли`);
    for (const b of replay.bad.slice(0, 20)) console.log(`  БИТЫЙ ${b.name}: ${b.reason}`);
    if (replay.bad.length > 20) console.log(`  … и ещё ${replay.bad.length - 20}`);
  }

  const headAfter = headHeight(dir);
  const verdict = chainVerdict(replay);

  publishAtomic(outPath, {
    kind: 'matricarmz-ledger-rebuilt-state',
    builtFromHeight: replay.lastHeight,
    blocks: replay.blocks,
    txs: replay.txs,
    headBefore,
    headAfter,
    verdict: verdict.verdict,
    badBlocks: replay.bad,
    gaps: replay.gaps,
    ghosts: replay.ghosts,
    state: replay.state,
  });

  console.log(`head до прохода ${headBefore}, после ${headAfter}${headAfter !== headBefore ? ' — приехали новые блоки, состояние собрано до высоты ' + replay.lastHeight : ''}`);
  console.log(`ВЕРДИКТ: ${verdict.verdict} — ${verdict.detail}`);
  process.exitCode = exitCodeFor(verdict.verdict);
}

try {
  main();
} catch (e) {
  console.error(String((e as Error)?.message ?? e));
  process.exitCode = 2;
}
