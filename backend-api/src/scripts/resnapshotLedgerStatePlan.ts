import type { LedgerState } from '@matricarmz/ledger';

// Чистая половина ledger:resnapshot-state. Ни файлов, ни БД, ни ключей: только правила
// сборки проекции из строк PostgreSQL и сверка двух состояний по открытому тексту.
//
// Решение владельца 2026-09-04 (вариант А): PostgreSQL — истина, state.json переснимается из
// него, цепочка блоков остаётся журналом. Разбор, почему цепочка истиной быть не может,
// — PENDING §«Второй прогон rebuild-state» (проекция отставала в эпоху гонки, блок-призрак
// 386592, записи мимо ledger'а).

export type Row = Record<string, unknown>;
export type Tables = Record<string, Record<string, Row>>;

export type ResnapshotArgs = { apply: boolean; backupDir: string; chainRebuiltPath: string; reportPath: string };

export function parseResnapshotArgs(argv: string[]): ResnapshotArgs {
  const out: ResnapshotArgs = { apply: false, backupDir: '', chainRebuiltPath: '', reportPath: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') out.apply = true;
    else if (a === '--backup-dir') out.backupDir = String(argv[++i] ?? '');
    else if (a === '--chain-rebuilt') out.chainRebuiltPath = String(argv[++i] ?? '');
    else if (a === '--report') out.reportPath = String(argv[++i] ?? '');
    else throw new Error(`неизвестный аргумент: ${a}`);
  }
  if (out.apply && !out.backupDir) throw new Error('--apply требует --backup-dir <каталог снаружи леджера>');
  return out;
}

// Бэкап живой проекции обязан лежать СНАРУЖИ каталога леджера — по тем же двум причинам, что
// и у rebuild-state: файл в корне уезжает в ночной бэкап и учитывается в его проверке места,
// а имя с префиксом `state.json.bak.` делает файл кандидатом на автовосстановление.
export function backupDirAllowed(backupAbs: string, ledgerDirAbs: string, relativeFn: (from: string, to: string) => string): boolean {
  const rel = relativeFn(ledgerDirAbs, backupAbs);
  if (rel === '') return false;
  if (rel.startsWith('..')) return true;
  return /^[A-Za-z]:/.test(rel);
}

// Строка проекции — это то, что оставил бы applyTx для upsert той же DTO-строки: сама строка
// плюс updated_at как метка транзакции. Bootstrap строит ledger-транзакции ровно так же
// (ensureLedgerBootstrap: ts = updated_at строки), поэтому пересъёмка даёт ту же форму,
// что и штатная запись. У таблиц без updated_at (движения склада) берём последнюю известную
// метку времени строки, чтобы поле не стало null.
export function projectionRow(row: Row): Row {
  const ts = Number(row.updated_at ?? row.performed_at ?? row.created_at ?? 0);
  return { ...row, updated_at: Number.isFinite(ts) ? ts : 0 };
}

export type BuildInput = {
  // ledger-таблица → DTO-строки из PostgreSQL (уже toSyncRow, ещё НЕ зашифрованные).
  pgTables: Record<string, Row[]>;
  live: LedgerState;
  // Пересборка из цепочки (rebuild-state --out) — источник только для таблиц, у которых нет
  // PG-источника (release_registry живёт исключительно в ledger'е).
  chainRebuilt?: LedgerState | null;
  encryptRow: (row: Row) => Row;
};

export type BuildResult = {
  state: LedgerState;
  fromPg: string[];
  keptFromLive: string[];
  mergedFromChain: Record<string, number>;
};

export function buildProjectionFromPg(input: BuildInput): BuildResult {
  const tables: Tables = {};
  const fromPg: string[] = [];
  const keptFromLive: string[] = [];
  const mergedFromChain: Record<string, number> = {};
  const liveTables = input.live.tables as Tables;

  for (const [table, rows] of Object.entries(input.pgTables)) {
    const out: Record<string, Row> = {};
    for (const row of rows) {
      const id = String(row.id ?? '');
      if (!id) continue;
      out[id] = input.encryptRow(projectionRow(row));
    }
    tables[table] = out;
    fromPg.push(table);
  }

  // Таблицы без PG-источника: живая проекция как есть. Если дана пересборка из цепочки —
  // добираем из неё строки, которых в проекции нет или которые в цепочке новее: у этих
  // таблиц цепочка — единственный писатель, и «проекция отстала» для них лечится только так.
  const chainTables = (input.chainRebuilt?.tables ?? {}) as Tables;
  const extraNames = new Set<string>([...Object.keys(liveTables), ...Object.keys(chainTables)]);
  for (const table of [...extraNames].sort()) {
    if (table in tables) continue;
    const out: Record<string, Row> = { ...(liveTables[table] ?? {}) };
    let merged = 0;
    for (const [id, row] of Object.entries(chainTables[table] ?? {})) {
      const cur = out[id];
      if (!cur || Number(row.updated_at ?? 0) > Number(cur.updated_at ?? 0)) {
        out[id] = row;
        merged += 1;
      }
    }
    tables[table] = out;
    keptFromLive.push(table);
    if (merged > 0) mergedFromChain[table] = merged;
  }

  return { state: { tables: tables as LedgerState['tables'] }, fromPg, keptFromLive, mergedFromChain };
}

export type TableDiff = {
  table: string;
  left: number;
  right: number;
  onlyLeft: number;
  onlyRight: number;
  differing: number;
  fields: Record<string, number>;
  sampleOnlyLeft: string[];
  sampleOnlyRight: string[];
  sampleDiffering: string[];
};

function stable(v: unknown): string {
  if (v == null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

// Сверка по ОТКРЫТОМУ тексту. Шифротекст сравнивать нельзя: у AES-GCM случайный IV, и одна и
// та же строка, зашифрованная дважды, различается байтами; после ротации ключа различается
// ещё и эпоха (`enc:v1` в блоках против `enc:v2` в проекции). Второй прогон rebuild-state
// 04.09 показал ~5 тыс. таких «расхождений», которые расхождениями не были.
export function diffStates(left: LedgerState, right: LedgerState, decryptRow: (row: Row) => Row, sampleSize = 3): TableDiff[] {
  const lt = left.tables as Tables;
  const rt = right.tables as Tables;
  const names = [...new Set([...Object.keys(lt), ...Object.keys(rt)])].sort();
  const result: TableDiff[] = [];
  for (const table of names) {
    const a = lt[table] ?? {};
    const b = rt[table] ?? {};
    const d: TableDiff = {
      table,
      left: Object.keys(a).length,
      right: Object.keys(b).length,
      onlyLeft: 0,
      onlyRight: 0,
      differing: 0,
      fields: {},
      sampleOnlyLeft: [],
      sampleOnlyRight: [],
      sampleDiffering: [],
    };
    for (const id of Object.keys(a)) {
      if (!(id in b)) {
        d.onlyLeft += 1;
        if (d.sampleOnlyLeft.length < sampleSize) d.sampleOnlyLeft.push(id);
        continue;
      }
      const ra = decryptRow(a[id]!);
      const rb = decryptRow(b[id]!);
      if (stable(ra) === stable(rb)) continue;
      d.differing += 1;
      if (d.sampleDiffering.length < sampleSize) d.sampleDiffering.push(id);
      for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
        if (stable(ra[k]) !== stable(rb[k])) d.fields[k] = (d.fields[k] ?? 0) + 1;
      }
    }
    for (const id of Object.keys(b)) {
      if (!(id in a)) {
        d.onlyRight += 1;
        if (d.sampleOnlyRight.length < sampleSize) d.sampleOnlyRight.push(id);
      }
    }
    if (d.onlyLeft || d.onlyRight || d.differing) result.push(d);
  }
  return result;
}

export function formatTableDiff(d: TableDiff): string {
  const fields = Object.entries(d.fields)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ');
  const lines = [`${d.table}: PG=${d.left} state.json=${d.right} толькоPG=${d.onlyLeft} толькоState=${d.onlyRight} разных=${d.differing}`];
  if (fields) lines.push(`    поля: ${fields}`);
  if (d.sampleOnlyLeft.length) lines.push(`    только в PG: ${d.sampleOnlyLeft.join(', ')}`);
  if (d.sampleOnlyRight.length) lines.push(`    только в state.json: ${d.sampleOnlyRight.join(', ')}`);
  if (d.sampleDiffering.length) lines.push(`    разные: ${d.sampleDiffering.join(', ')}`);
  return lines.join('\n');
}
