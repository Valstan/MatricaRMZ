import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { emptyLedgerState, type LedgerBlock, type LedgerSignedTx, type LedgerState } from '@matricarmz/ledger';
import { describe, expect, it, vi } from 'vitest';

import {
  compareStates,
  exitCodeFor,
  heightFromBlockFileName,
  isBlockFileName,
  orderedBlockFiles,
  outputPathAllowed,
  parseRebuildArgs,
  replayBlocks,
  type ReplayDeps,
} from './rebuildLedgerStatePlan.js';

function tx(over: Partial<LedgerSignedTx> = {}): LedgerSignedTx {
  return {
    tx_id: 't1',
    type: 'upsert',
    table: 'entities',
    row: { id: 'r1', name: 'первый' },
    actor: 'test',
    ts: 1000,
    seq: 1,
    signature: 'sig',
    public_key: 'pk',
    ...over,
  } as LedgerSignedTx;
}

function block(height: number, txs: LedgerSignedTx[]): LedgerBlock {
  return { height, prev_hash: '', created_at: height * 10, txs, hash: `h${height}` };
}

function stateWith(table: string, rows: Record<string, Record<string, unknown>>): LedgerState {
  const s = emptyLedgerState();
  (s.tables as Record<string, Record<string, Record<string, unknown>>>)[table] = rows;
  return s;
}

describe('parseRebuildArgs', () => {
  it('без аргументов — пустые значения по умолчанию', () => {
    expect(parseRebuildArgs([])).toEqual({ outPath: '', maxBlocks: 0, toHeight: 0 });
  });

  it('читает --out, --max-blocks и --to-height, в том числе через разделитель pnpm', () => {
    expect(parseRebuildArgs(['--out', '/tmp/a.json', '--max-blocks', '10', '--to-height', '100'])).toEqual({
      outPath: '/tmp/a.json',
      maxBlocks: 10,
      toHeight: 100,
    });
    expect(parseRebuildArgs(['--', '--to-height', '5'])).toMatchObject({ toHeight: 5 });
  });

  it('отказывает на мусоре, а не угадывает', () => {
    expect(() => parseRebuildArgs(['--out'])).toThrow(/--out/);
    expect(() => parseRebuildArgs(['--to-height', '-1'])).toThrow(/--to-height/);
    expect(() => parseRebuildArgs(['--to-height', 'сто'])).toThrow(/--to-height/);
    expect(() => parseRebuildArgs(['--force'])).toThrow(/неизвестный аргумент/);
  });
});

describe('отбор и порядок файлов блоков', () => {
  it('берёт только имена блоков и отсекает временные файлы writeFileAtomic', () => {
    expect(isBlockFileName('00000001.json')).toBe(true);
    expect(isBlockFileName('00000001.json.tmp-123-4')).toBe(false);
    expect(isBlockFileName('index.json')).toBe(false);
    expect(isBlockFileName('state.json')).toBe(false);
    expect(isBlockFileName('00000001.txt')).toBe(false);
  });

  it('сортирует по ЧИСЛОВОЙ высоте — там, где padStart(8) кончается, имена расходятся с порядком', () => {
    // 99999999 -> "99999999.json" (8 знаков), 100000000 -> "100000000.json" (9 знаков).
    // Лексикографически "100000000" < "99999999", то есть сортировка по имени переставила бы их.
    const names = ['100000000.json', '99999999.json', '00000002.json'];
    expect(orderedBlockFiles(names)).toEqual(['00000002.json', '99999999.json', '100000000.json']);
  });

  it('достаёт высоту из имени и отвергает чужие имена', () => {
    expect(heightFromBlockFileName('00000042.json')).toBe(42);
    expect(heightFromBlockFileName('checkpoint.json')).toBeNull();
  });
});

describe('replayBlocks', () => {
  function deps(blocks: LedgerBlock[]): ReplayDeps {
    const byName = new Map(blocks.map((b) => [`${String(b.height).padStart(8, '0')}.json`, b]));
    return {
      listBlockFiles: () => [...byName.keys()],
      readBlock: (n) => byName.get(n)!,
    };
  }

  it('идёт по возрастанию высоты и накапливает состояние', () => {
    const r = replayBlocks(
      deps([
        block(1, [tx({ row: { id: 'r1', name: 'первый' } })]),
        block(2, [tx({ tx_id: 't2', seq: 2, row: { id: 'r2', name: 'второй' } })]),
      ]),
    );
    expect(r.blocks).toBe(2);
    expect(r.txs).toBe(2);
    expect(r.lastHeight).toBe(2);
    expect(Object.keys(r.state.tables.entities).sort()).toEqual(['r1', 'r2']);
  });

  it('стартует с emptyLedgerState: пустые таблицы обязаны присутствовать, они входят в хеш', () => {
    const r = replayBlocks(deps([block(1, [tx()])]));
    expect(Object.keys(r.state.tables).length).toBe(Object.keys(emptyLedgerState().tables).length);
  });

  it('удаление оставляет тумстоун с телом строки, а не выкидывает её', () => {
    const r = replayBlocks(
      deps([
        block(1, [tx({ row: { id: 'r1', name: 'первый' } })]),
        block(2, [tx({ tx_id: 't2', seq: 2, type: 'delete', row_id: 'r1', ts: 2000 })]),
      ]),
    );
    const row = r.state.tables.entities.r1 as Record<string, unknown>;
    expect(row.deleted_at).toBe(2000);
    expect(row.name).toBe('первый');
  });

  it('нечитаемый блок называет себя и не роняет прогон — остальные блоки доигрываются', () => {
    const d = deps([block(1, [tx()]), block(2, [tx({ tx_id: 't2', seq: 2 })])]);
    const r = replayBlocks({
      ...d,
      readBlock: (n) => {
        if (n === '00000001.json') throw new Error('Unexpected non-whitespace character after JSON at position 1186');
        return d.readBlock(n);
      },
    });
    expect(r.bad).toEqual([{ name: '00000001.json', reason: expect.stringContaining('position 1186') }]);
    expect(r.blocks).toBe(1);
    expect(r.lastHeight).toBe(2);
  });

  it('считает разрывы высоты, а не проглатывает их', () => {
    const r = replayBlocks(deps([block(1, [tx()]), block(5, [tx({ tx_id: 't2', seq: 2 })])]));
    expect(r.gaps).toEqual([5]);
  });

  it('--to-height останавливает прогон на заданной высоте', () => {
    const r = replayBlocks(deps([block(1, [tx()]), block(2, [tx({ tx_id: 't2', seq: 2 })]), block(3, [tx({ tx_id: 't3', seq: 3 })])]), { toHeight: 2 });
    expect(r.lastHeight).toBe(2);
    expect(r.blocks).toBe(2);
  });

  it('--max-blocks ограничивает число прочитанных блоков', () => {
    const r = replayBlocks(deps([block(1, [tx()]), block(2, [tx({ tx_id: 't2', seq: 2 })]), block(3, [tx({ tx_id: 't3', seq: 3 })])]), { maxBlocks: 1 });
    expect(r.blocks).toBe(1);
  });

  it('читает каждый блок ровно один раз — квадратичного чтения быть не должно', () => {
    const d = deps([block(1, [tx()]), block(2, [tx({ tx_id: 't2', seq: 2 })])]);
    const spy = vi.fn(d.readBlock);
    replayBlocks({ ...d, readBlock: spy });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('compareStates — вердикт по потабличным хешам, а не по stateHash', () => {
  it('одинаковые состояния — MATCH', () => {
    const a = stateWith('entities', { r1: { id: 'r1', v: 1 } });
    const b = stateWith('entities', { r1: { id: 'r1', v: 1 } });
    expect(compareStates(a, b)).toMatchObject({ verdict: 'MATCH', stateHashEqual: true });
  });

  it('разные данные в общей таблице — DATA_DIVERGENCE', () => {
    const a = stateWith('entities', { r1: { id: 'r1', v: 1 } });
    const b = stateWith('entities', { r1: { id: 'r1', v: 2 } });
    const r = compareStates(a, b);
    expect(r.verdict).toBe('DATA_DIVERGENCE');
    expect(r.divergentTables).toContain('entities');
  });

  it('лишняя ПУСТАЯ таблица — TABLE_SET_SKEW, а не повреждение: данные совпадают до байта', () => {
    const rebuilt = stateWith('entities', { r1: { id: 'r1' } });
    const live = stateWith('entities', { r1: { id: 'r1' } });
    delete (live.tables as Record<string, unknown>)['user_section_access'];
    const r = compareStates(rebuilt, live);
    expect(r.verdict).toBe('TABLE_SET_SKEW');
    expect(r.onlyInRebuilt).toEqual(['user_section_access']);
    expect(r.divergentTables).toEqual([]);
    expect(r.stateHashEqual).toBe(false); // именно поэтому судить по stateHash нельзя
    expect(exitCodeFor(r.verdict)).toBe(0);
  });

  it('лишняя НЕПУСТАЯ таблица — уже DATA_DIVERGENCE: это данные, которых пересборка не воспроизвела', () => {
    const rebuilt = stateWith('entities', { r1: { id: 'r1' } });
    const live = stateWith('entities', { r1: { id: 'r1' } });
    (live.tables as Record<string, Record<string, unknown>>)['user_section_access'] = { u1: { id: 'u1' } };
    delete (rebuilt.tables as Record<string, unknown>)['user_section_access'];
    const r = compareStates(rebuilt, live);
    expect(r.verdict).toBe('DATA_DIVERGENCE');
    expect(r.emptyAsymmetric).toBe(false);
  });

  it('коды возврата: выводимость из цепочки — 0, расхождение — 1', () => {
    expect(exitCodeFor('MATCH')).toBe(0);
    expect(exitCodeFor('TABLE_SET_SKEW')).toBe(0);
    expect(exitCodeFor('DATA_DIVERGENCE')).toBe(1);
    expect(exitCodeFor('HEAD_MOVED')).toBe(1);
  });
});

// Сторож структурного отказа. Инструмент обязан быть не-мутирующим по УСТРОЙСТВУ, а не по
// обещанию в комментарии: файл в корне леджера уезжает в ночной бэкап, а имя вида
// state.json.bak.* подхватывается автовосстановлением как живое состояние.
describe('инструмент не имеет пути записи в каталог леджера', () => {
  // Сторож обязан судить по КОДУ, а не по тексту объяснений: в шапке файла как раз описано,
  // почему нельзя писать в каталог леджера и почему имя state.json.bak.* опасно. Первая версия
  // этого сторожа ловила собственные комментарии и краснела на исправном коде — а сторож,
  // который врёт на здоровом файле, перестают слушать раньше, чем он поймает настоящее.
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const src = stripComments(readFileSync(join(__dirname, 'rebuildLedgerState.ts'), 'utf8'));

  it('сам сторож смотрит на код, а не на комментарии', () => {
    expect(stripComments('const a = 1; // getLedgerStore()')).not.toMatch(/getLedgerStore/);
    expect(stripComments('/* state.json.bak */ const b = 2;')).not.toMatch(/state\.json\.bak/);
    expect(stripComments('const url = "https://x/y";')).toMatch(/https:\/\/x\/y/);
    expect(stripComments('getLedgerStore();')).toMatch(/getLedgerStore/);
  });

  it('не импортирует ledgerService: getLedgerStore() чинит state.json, то есть мутирует', () => {
    expect(src).not.toMatch(/from\s+['"].*ledger\/ledgerService/);
    expect(src).not.toMatch(/getLedgerStore/);
  });

  it('единственная запись идёт в --out и проходит через проверку «снаружи леджера»', () => {
    expect(src).toMatch(/assertOutsideLedger/);
    // mkdirSync отсутствует вовсе: каталог леджера не создаём даже случайно.
    expect(src).not.toMatch(/mkdirSync/);
    // Никаких saveState/appendBlock/writeFileAtomic по путям леджера.
    expect(src).not.toMatch(/saveState|appendBlock|appendRemoteBlock|saveIndex|saveCheckpoint/);
  });

  it('проверка пути вынесена в чистую половину и вызывается до чтения блоков', () => {
    expect(src).toMatch(/outputPathAllowed/);
  });
});

// Сам отказ проверяем поведением на реальных путях, а не грепом по исходнику: греп ловил
// собственное сообщение об ошибке и краснел на исправном коде.
describe('outputPathAllowed', () => {
  const rel = (from: string, to: string) => relative(from, to);
  const LED = '/srv/matricarmz-ledger';

  it('запрещает корень каталога леджера и всё внутри него', () => {
    expect(outputPathAllowed(LED, LED, rel)).toBe(false);
    expect(outputPathAllowed(`${LED}/rebuilt.json`, LED, rel)).toBe(false);
    expect(outputPathAllowed(`${LED}/blocks/x.json`, LED, rel)).toBe(false);
    // Главная ловушка: такое имя автовосстановление подхватит как живое состояние.
    expect(outputPathAllowed(`${LED}/state.json.bak.1`, LED, rel)).toBe(false);
  });

  it('разрешает пути снаружи, включая соседний каталог с похожим именем', () => {
    expect(outputPathAllowed('/tmp/rebuilt.json', LED, rel)).toBe(true);
    expect(outputPathAllowed('/srv/matricarmz-ledger-check/rebuilt.json', LED, rel)).toBe(true);
    expect(outputPathAllowed('/srv/other/rebuilt.json', LED, rel)).toBe(true);
  });

  it('другой диск в Windows — это снаружи', () => {
    const win = (from: string, to: string) => (to[0] !== from[0] ? to : relative(from, to));
    expect(outputPathAllowed('E:\\tmp\\rebuilt.json', 'D:\\ledger', win)).toBe(true);
  });
});
