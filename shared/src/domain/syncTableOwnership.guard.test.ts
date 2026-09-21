import { describe, expect, it } from 'vitest';

import {
  SYNC_TABLE_OWNERSHIP,
  isServerManagedSyncTable,
  ledgerWriteRequirement,
  operatorMeetsRequirement,
} from './ledgerAuthz.js';
import { operatorRolePermissions } from './permissions.js';
import { SyncTableName } from '../sync/tables.js';

// Сторож механизма «кто владеет строкой» (brain #015, 2026-09-21). Класс «таблица гейтится
// только по имени» лечился четырежды исключениями (M17, M34/M35, M36, M135); этот тест
// краснеет на ПЯТОЙ попытке: новая таблица контракта без разметки владения, разметка,
// разошедшаяся с requirement'ом, серверная таблица, выпавшая из backstop'а.

const ALL_TABLES = Object.values(SyncTableName);
const OPERATOR_ROLES = ['engineer', 'technolog', 'master', 'supply', 'storekeeper', 'timekeeper', 'viewer'];

describe('SYNC_TABLE_OWNERSHIP — каждая таблица контракта размечена', () => {
  it('ровно те же таблицы, что в SyncTableName — ни лишних, ни забытых', () => {
    // Типизация Record<SyncTableName, …> ловит забытую таблицу на typecheck; здесь — вторая
    // линия для прогона тестов без typecheck и защита от лишних ключей через `as any`.
    expect(Object.keys(SYNC_TABLE_OWNERSHIP).sort()).toEqual([...ALL_TABLES].sort());
  });

  it('владение `server` ⇔ таблица в backstop server-managed (одно множество, один источник)', () => {
    for (const t of ALL_TABLES) {
      const expected = SYNC_TABLE_OWNERSHIP[t].owner === 'server';
      expect(isServerManagedSyncTable(t), t).toBe(expected);
    }
  });

  it('серверную таблицу не удовлетворяет ни одна операторская роль, и requirement у неё не open', () => {
    for (const t of ALL_TABLES) {
      if (SYNC_TABLE_OWNERSHIP[t].owner !== 'server') continue;
      const req = ledgerWriteRequirement({ table: t });
      expect(req.kind, t).not.toBe('open');
      for (const role of OPERATOR_ROLES) {
        const perms = operatorRolePermissions(role)!;
        expect(operatorMeetsRequirement(req, { perms, actorId: 'self', ownerEntityId: 'self' }), `${role}/${t}`).toBe(false);
      }
    }
  });

  it('владение `permission` ⇔ requirement по таблице kind=permission', () => {
    for (const t of ALL_TABLES) {
      const own = SYNC_TABLE_OWNERSHIP[t];
      if (own.owner === 'type') continue; // требование берётся по коду типа, не по таблице
      const req = ledgerWriteRequirement({ table: t });
      if (own.owner === 'permission') {
        expect(req.kind, t).toBe('permission');
      } else {
        expect(req.kind, t).not.toBe('permission');
      }
    }
  });

  it('row / session / append_only / schema — открыты на уровне таблицы, потому что проверка живёт ниже', () => {
    for (const t of ALL_TABLES) {
      const own = SYNC_TABLE_OWNERSHIP[t];
      if (own.owner === 'row' || own.owner === 'session' || own.owner === 'append_only' || own.owner === 'schema') {
        expect(ledgerWriteRequirement({ table: t }).kind, t).toBe('open');
      }
    }
  });

  it('у каждой row-таблицы назван столбец владельца и причина отказа, по которой её ищет сторож бэкенда', () => {
    for (const t of ALL_TABLES) {
      const own = SYNC_TABLE_OWNERSHIP[t];
      if (own.owner !== 'row') continue;
      expect(own.column.length, t).toBeGreaterThan(0);
      expect(own.guard.length, t).toBeGreaterThan(0);
    }
  });

  it('таблица вне разметки (крафтовое имя) — закрыта', () => {
    expect(ledgerWriteRequirement({ table: 'erp_document_headers' }).kind).toBe('superadmin');
    expect(ledgerWriteRequirement({ table: '' }).kind).toBe('superadmin');
  });
});
