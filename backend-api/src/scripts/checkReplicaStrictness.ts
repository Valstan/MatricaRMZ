// Гейт #086: клиентская SQLite-реплика не имеет права быть СТРОЖЕ серверного источника.
// Всё, что сервер может прислать sync'ом, клиент обязан суметь вставить.
// Сравнение направленное (client ⊆ server), не равенство: реплика мягче источника — безвредна.
// Инцидент-образец: глобальный UNIQUE на code в клиенте при разрешённых дублях на сервере
// (145 пустых кодов роняли локальную БД до клиентской миграции 0016).

import { getTableConfig as pgTableConfig } from 'drizzle-orm/pg-core';
import { getTableConfig as sqliteTableConfig } from 'drizzle-orm/sqlite-core';
import { SyncTableName } from '@matricarmz/shared';

import * as serverSchema from '../database/schema.js';

type ColumnInfo = { name: string; notNull: boolean; hasDefault: boolean; primary: boolean };
type UniqueInfo = { columns: string[]; partial: boolean; nullGuardOnly: boolean; label: string };
type TableInfo = { columns: Map<string, ColumnInfo>; uniques: UniqueInfo[]; pk: string[] };

// Осознанные исторические расхождения. Каждая запись — с причиной; пустой список = цель.
const ALLOWLIST = new Set<string>([]);

// where вида `col is not null [and col2 is not null ...]` по колонкам самого индекса
// эквивалентен полному unique в SQLite: там NULL-ключи в unique-индексе не конфликтуют.
function isNullGuardOnlyWhere(where: unknown, indexColumns: string[]): boolean {
  const chunks = (where as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return false;
  let text = '';
  for (const chunk of chunks) {
    if (Array.isArray((chunk as { value?: unknown }).value)) {
      text += ((chunk as { value: unknown[] }).value as string[]).join('');
    } else if (typeof (chunk as { name?: unknown }).name === 'string') {
      const colName = (chunk as { name: string }).name;
      if (!indexColumns.includes(colName)) return false;
      text += 'COL';
    } else {
      return false;
    }
  }
  return /^\s*(COL\s+is\s+not\s+null\s*)(and\s+COL\s+is\s+not\s+null\s*)*$/i.test(text);
}

function collectTables(
  schemaModule: Record<string, unknown>,
  getConfig: (t: never) => {
    name: string;
    columns: readonly unknown[];
    indexes: readonly unknown[];
    uniqueConstraints: readonly unknown[];
  },
): Map<string, TableInfo> {
  const out = new Map<string, TableInfo>();
  for (const value of Object.values(schemaModule)) {
    let cfg;
    try {
      cfg = getConfig(value as never);
    } catch {
      continue;
    }
    const columns = new Map<string, ColumnInfo>();
    const pk: string[] = [];
    for (const raw of cfg.columns) {
      const col = raw as { name: string; notNull: boolean; hasDefault: boolean; primary: boolean; isUnique: boolean };
      columns.set(col.name, {
        name: col.name,
        notNull: col.notNull,
        hasDefault: col.hasDefault,
        primary: col.primary,
      });
      if (col.primary) pk.push(col.name);
    }
    const uniques: UniqueInfo[] = [];
    for (const raw of cfg.columns) {
      const col = raw as { name: string; isUnique: boolean };
      if (col.isUnique) uniques.push({ columns: [col.name], partial: false, nullGuardOnly: false, label: `unique(${col.name})` });
    }
    for (const raw of cfg.indexes) {
      const idx = raw as { config?: { name?: string; unique?: boolean; where?: unknown; columns: Array<{ name?: string }> } };
      if (!idx.config?.unique) continue;
      const columns = idx.config.columns.map((c) => c.name ?? '<expr>').sort();
      uniques.push({
        columns,
        partial: idx.config.where != null,
        nullGuardOnly: idx.config.where != null && isNullGuardOnlyWhere(idx.config.where, columns),
        label: idx.config.name ?? 'unique index',
      });
    }
    for (const raw of cfg.uniqueConstraints) {
      const uc = raw as { name?: string; columns: Array<{ name?: string }> };
      uniques.push({
        columns: uc.columns.map((c) => c.name ?? '<expr>').sort(),
        partial: false,
        nullGuardOnly: false,
        label: uc.name ?? 'unique constraint',
      });
    }
    out.set(cfg.name, { columns, uniques, pk: pk.sort() });
  }
  return out;
}

function sameCols(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export async function checkReplicaStrictness(): Promise<string[]> {
  // Клиентская схема — вне rootDir backend-тсконфига, поэтому импорт динамический
  // (спецификатор собран в рантайме; скрипт гоняется только через tsx). Оба пакета
  // делят один инстанс drizzle-orm (pnpm store дедупит 0.45.2), поэтому getTableConfig
  // работает поверх чужих таблиц.
  const clientSchemaPath = new URL('../../../electron-app/src/main/database/schema.ts', import.meta.url).href;
  const clientSchema = (await import(clientSchemaPath)) as Record<string, unknown>;
  const client = collectTables(clientSchema, sqliteTableConfig as never);
  const server = collectTables(serverSchema, pgTableConfig as never);
  const violations: string[] = [];
  const report = (key: string, message: string) => {
    if (!ALLOWLIST.has(key)) violations.push(`${message} [${key}]`);
  };

  for (const tableName of Object.values(SyncTableName)) {
    const c = client.get(tableName);
    const s = server.get(tableName);
    if (!c) {
      // Таблица синкается, но в клиентской drizzle-схеме её нет — не наш класс проблем, ловит #034.
      continue;
    }
    if (!s) {
      report(`${tableName}:missing-on-server`, `${tableName}: есть в клиентской схеме и в SyncTableName, но нет в серверной схеме`);
      continue;
    }

    for (const col of c.columns.values()) {
      const sCol = s.columns.get(col.name);
      if (!sCol) {
        // Клиентская локальная колонка: безопасна, только если sync-вставка может её не заполнять.
        if (col.notNull && !col.hasDefault && !col.primary) {
          report(
            `${tableName}.${col.name}:client-only-notnull`,
            `${tableName}.${col.name}: NOT NULL без default только на клиенте — серверная строка без этого поля не вставится`,
          );
        }
        continue;
      }
      if (col.notNull && !sCol.notNull) {
        report(
          `${tableName}.${col.name}:notnull`,
          `${tableName}.${col.name}: NOT NULL на клиенте, nullable на сервере — серверный NULL уронит вставку`,
        );
      }
    }

    for (const uq of c.uniques) {
      if (sameCols(uq.columns, c.pk) && sameCols(c.pk, s.pk)) continue;
      const match = s.uniques.find((su) => sameCols(su.columns, uq.columns));
      if (!match) {
        report(
          `${tableName}:${uq.label}`,
          `${tableName}: клиентский ${uq.label} на (${uq.columns.join(', ')}) без серверного unique на тех же колонках — легитимные серверные дубли уронят вставку`,
        );
        continue;
      }
      if (!uq.partial && match.partial && !match.nullGuardOnly) {
        report(
          `${tableName}:${uq.label}:partial`,
          `${tableName}: клиентский ${uq.label} полный, серверный — частичный (where) — клиент строже на строках вне серверного фильтра`,
        );
      }
      // Оба partial: тексты where на разных диалектах не сравниваем — грубое направление уже закрыто.
    }
  }
  return violations;
}
