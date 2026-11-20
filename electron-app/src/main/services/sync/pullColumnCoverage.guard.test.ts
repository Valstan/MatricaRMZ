import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Сторож колонок реплики: то, что сервер отдал в pull, обязано попасть в локальную
 * БД клиента под своим именем.
 *
 * Инцидент 20.11.2026: в таблицы `ppe_issue_cards` / `ppe_norm_sets` вошёл вид СИЗ
 * (`kind`, миграция 0131). План нити перечислил четыре места, где поле надо было
 * продублировать (dto, реестр, издатель, схема реплики) — и все четыре обновили.
 * Пятое место — разбор pull в `applyPulledChanges` — забыли: клиент вставлял
 * карточку без `kind`, и SQLite брал дефолт колонки ('workwear'). Карточка по
 * мылу вставала в реплику как ещё одна карточка по спецодежде и била уникальный
 * индекс открытой карточки: `UNIQUE constraint failed: ppe_issue_cards.employee_id,
 * ppe_issue_cards.kind` — падал весь батч pull, то есть синхронизация у всего
 * парка. Поле потерялось молча: ни ошибки, ни красного теста, сервер при этом
 * полностью законен.
 *
 * Тот же класс нашёлся рядом, и тоже молча: поля `trade_name` / `certificate`
 * (приказные строки) и `returned_at` / `returned_by` / `wear_percent` (возврат СИЗ)
 * не везлись в реплику вообще — выгрузка для 1С брала из этих таблиц имя позиции,
 * подразделение и должность и выдавала пустоту.
 *
 * Почему исходником, а не поведением. Пропущенное поле не даёт ни ошибки, ни
 * красного теста — insert берёт дефолт колонки, и реплика хранит не то. Ловить
 * это поведением можно только построением настоящего pull'а против живого
 * сервера, а контракт известен точно: реестр `shared/src/sync/registry.ts`
 * перечисляет поля строки каждой таблицы, а схема реплики клиента — колонки
 * каждой таблицы.
 *
 * Контракт читается из исходников, а не из `@matricarmz/shared`: собранный
 * `dist` может отставать от исходника, и тогда новое поле прошло бы мимо
 * сторожа именно в тот момент, когда он нужен (та же причина, что в
 * `pullApplyCoverage.guard.test.ts`).
 */
const SERVICE = readFileSync(new URL('../syncService.ts', import.meta.url), 'utf8');
const REGISTRY = readFileSync(new URL('../../../../../shared/src/sync/registry.ts', import.meta.url), 'utf8');
const TABLES = readFileSync(new URL('../../../../../shared/src/sync/tables.ts', import.meta.url), 'utf8');
const CLIENT_SCHEMA = readFileSync(new URL('../../database/schema.ts', import.meta.url), 'utf8');

/**
 * Поля, которые клиент не берёт из payload по существу: `sync_status` — это
 * локальная метка клиента ('synced'), серверное значение в реплику не нужно.
 */
const NOT_TAKEN_FROM_PAYLOAD = new Set(['sync_status']);

/** Срез от открывающей скобки до её пары — без догадок о переводе строк. */
function balanced(source: string, openIndex: number, open: string, close: string): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return source.slice(openIndex + 1);
}

function dtoNames(source: string): string[] {
  return [...source.matchAll(/dto:\s*'([^']+)'/g)].map((m) => m[1] as string);
}

/** Ключ SyncTableName → имя таблицы контракта. */
function contractTableNames(): Map<string, string> {
  const start = TABLES.indexOf('export const SyncTableName = {');
  expect(start, 'в tables.ts не найден объект SyncTableName').toBeGreaterThan(-1);
  const block = TABLES.slice(start, TABLES.indexOf('}', start));
  const out = new Map<string, string>();
  for (const m of block.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)) out.set(m[1] as string, m[2] as string);
  return out;
}

/** Базовый хвост строки: id/created_at/updated_at/last_server_seq/deleted_at/sync_status. */
function baseDtoFields(): string[] {
  const start = REGISTRY.indexOf('const BASE_FIELDS');
  expect(start, 'в registry.ts не найден BASE_FIELDS').toBeGreaterThan(-1);
  // Массив начинается после `=`, а не в аннотации типа `readonly FieldMapping[]`.
  const open = REGISTRY.indexOf('[', REGISTRY.indexOf('=', start));
  return dtoNames(balanced(REGISTRY, open, '[', ']'));
}

/**
 * Константа полей → dto-имена. Формы две: `withBase(...)` (добавляет базовый хвост)
 * и явный массив `readonly FieldMapping[] = [...]` (хвост перечислен руками).
 */
function fieldsByConstant(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /const (\w+_FIELDS)(?::[^=]+)?\s*=\s*(withBase\(|\[)/g;
  for (const m of REGISTRY.matchAll(re)) {
    const isArray = m[2] === '[';
    const open = (m.index ?? 0) + m[0].length - 1;
    const body = balanced(REGISTRY, open, isArray ? '[' : '(', isArray ? ']' : ')');
    out.set(m[1] as string, [...baseDtoFields(), ...dtoNames(body)]);
  }
  return out;
}

/** Таблица контракта → константа её полей (из массива записей реестра). */
function tableFieldConstants(): Map<string, string> {
  const out = new Map<string, string>();
  // Граница записи — открывающая строка `{` на уровне массива: поля не ищем
  // через запись, чтобы `fields` не достался от соседней таблицы.
  const re = /syncName:\s*SyncTableName\.(\w+),((?:(?!\n {2}\{)[\s\S])*?)fields:\s*(\w+),/g;
  for (const m of REGISTRY.matchAll(re)) out.set(m[1] as string, m[3] as string);
  return out;
}

/** Таблица реплики клиента → её колонки (из `sqliteTable` в схеме клиента). */
function clientReplicaColumns(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /sqliteTable\('([^']+)'/g;
  for (const m of CLIENT_SCHEMA.matchAll(re)) {
    const open = CLIENT_SCHEMA.indexOf('{', (m.index ?? 0) + m[0].length - 1);
    const body = balanced(CLIENT_SCHEMA, open, '{', '}');
    // Только объявления колонок (`поле: text('колонка')`) — дефолты вида
    // `.default('synced')` за колонки не считаются.
    out.set(m[1] as string, [...body.matchAll(/^\s*(\w+):\s*\w+\('([^']+)'/gm)].map((x) => x[2] as string));
  }
  return out;
}

interface ClientCase {
  /** Ключ SyncTableName. */
  key: string;
  /** Имя группы, в которую кладёт разбор pull. */
  group: string;
  /** dto-имена, реально взятые из payload. */
  keys: Set<string>;
}

/** Клиентские `case` в разборе pull: ключ → dto-ключи из payload. */
function clientCases(): ClientCase[] {
  const start = SERVICE.indexOf('for (const item of parsedChanges) {');
  expect(start, 'в syncService.ts не найден разбор parsedChanges').toBeGreaterThan(-1);
  const end = SERVICE.indexOf('function isNewerRow(', start);
  expect(end, 'не найден конец switch применения pull').toBeGreaterThan(start);
  const src = SERVICE.slice(start, end);
  const out: ClientCase[] = [];
  const re = /case SyncTableName\.(\w+):([\s\S]*?)(?=\n[ \t]*case SyncTableName\.|\n[ \t]*default:)/g;
  for (const m of src.matchAll(re)) {
    const block = m[2] ?? '';
    const group = block.match(/groups\.(\w+)\.push\(/)?.[1] ?? '';
    const keys = new Set(
      [...block.matchAll(/\b(?:payload|payloadRaw)\.(\w+)/g)].map((x) => x[1] ?? ''),
    );
    out.push({ key: m[1] ?? '', group, keys });
  }
  return out;
}

/**
 * Conflict-set таблицы: колонки, которые обновляются при повторном pull.
 * Поле, которого нет в наборе, вставляется один раз — и больше не обновляется:
 * реплика хранит первое значение, а не серверное.
 */
function conflictSetColumns(group: string): Set<string> {
  const out = new Set<string>();
  const re = new RegExp(
    `upsertPulledRowsInChunks\\(db, (\\w+), groups\\.${group}, \\1\\.id, \\{`,
  );
  const m = SERVICE.match(re);
  if (!m || m.index === undefined) return out;
  const open = SERVICE.indexOf('{', m.index + m[0].length - 1);
  const body = balanced(SERVICE, open, '{', '}');
  for (const c of body.matchAll(/(\w+):\s*sql`excluded\.(\w+)`/g)) out.add(c[2] as string);
  return out;
}

describe('колонки контракта доезжают до реплики клиента', () => {
  it('каждая колонка реплики заполняется из payload и есть в контракте', () => {
    const fields = fieldsByConstant();
    const tableConsts = tableFieldConstants();
    const replica = clientReplicaColumns();
    const cases = clientCases();
    const contract = contractTableNames();

    const problems: string[] = [];
    for (const c of cases) {
      const tableName = contract.get(c.key);
      if (!tableName) continue;
      const cols = replica.get(tableName);
      if (!cols) continue; // таблицы нет в реплике клиента — она её не держит
      const constName = tableConsts.get(c.key);
      const contractFields = constName ? fields.get(constName) : undefined;
      for (const col of cols) {
        if (NOT_TAKEN_FROM_PAYLOAD.has(col)) continue;
        if (!c.keys.has(col)) {
          problems.push(`${tableName}: колонка «${col}» не заполняется в applyPulledChanges`);
          continue;
        }
        // Колонка есть у клиента, но сервер её не публикует — в реплике вечно
        // будет дефолт: молчаливая потеря поля с другой стороны.
        if (contractFields && !contractFields.includes(col)) {
          problems.push(`${tableName}: колонка «${col}» есть в реплике, но её нет в контракте синхронизации`);
        }
      }
    }
    expect(
      problems,
      `колонки реплики не заполняются: ${problems.join('; ')} — молчаливая потеря данных в pull`,
    ).toEqual([]);
  });

  it('каждая колонка реплики обновляется при повторном pull', () => {
    const replica = clientReplicaColumns();
    const cases = clientCases();
    const contract = contractTableNames();

    // Идентификатор строки не обновляется, `created_at` неизменен по существу,
    // `sync_status` — локальная метка клиента.
    const NOT_UPDATED = new Set(['id', 'created_at', 'sync_status']);

    const problems: string[] = [];
    for (const c of cases) {
      const tableName = contract.get(c.key);
      if (!tableName || !c.group) continue;
      const cols = replica.get(tableName);
      if (!cols) continue;
      const conflictSet = conflictSetColumns(c.group);
      if (conflictSet.size === 0) continue; // таблица применяется не через upsert
      for (const col of cols) {
        if (NOT_UPDATED.has(col)) continue;
        if (!conflictSet.has(col)) {
          problems.push(`${tableName}: колонка «${col}» не обновляется при повторном pull`);
        }
      }
    }
    expect(
      problems,
      `колонки реплики не обновляются: ${problems.join('; ')} — реплика хранит первое значение, а не серверное`,
    ).toEqual([]);
  });
});
