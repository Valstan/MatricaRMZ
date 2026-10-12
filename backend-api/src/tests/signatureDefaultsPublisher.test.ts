import { SyncTableName, SyncTableRegistry, syncRowSchemaByTable } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

import { toSignatureDefaultInput } from '../services/sync/signatureDefaultsSyncPublisherService.js';

// Зеркало умолчаний ведёт админская дверь обычными insert/update, мимо пути
// записи синхронизации. Строка без номера журнала не доедет инкрементальным
// pull'ом НИКОГДА. Публикатор закрывает разрыв — и его входная строка обязана
// проходить схему контракта.
const UID = '11111111-1111-4111-8111-111111111111';
const BASE = { id: UID, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_001_000, deletedAt: null, syncStatus: 'pending', lastServerSeq: null };

describe('публикация зеркала умолчаний подписей', () => {
  const row = { ...BASE, fieldKey: 'defect_signed_by', employeeId: UID };

  it('signature_defaults: строка публикации проходит схему контракта', () => {
    const input = toSignatureDefaultInput({ ...row });
    const parsed = syncRowSchemaByTable[SyncTableName.SignatureDefaults].safeParse(input.row);
    expect(parsed.success, parsed.success ? '' : JSON.stringify((parsed as { error: { issues: unknown } }).error.issues)).toBe(true);
  });

  it('signature_defaults: живая строка — upsert, снятая — delete', () => {
    expect(toSignatureDefaultInput({ ...row }).type).toBe('upsert');
    expect(toSignatureDefaultInput({ ...row, deletedAt: 1_700_000_002_000 }).type).toBe('delete');
  });

  it('signature_defaults: поля в snake_case ровно как ждёт реестр (кроме ledger-owned)', () => {
    const input = toSignatureDefaultInput({ ...row });
    const fromRegistry = SyncTableRegistry.toSyncRow(SyncTableName.SignatureDefaults, { ...row });
    const ledgerOwned = new Set(['last_server_seq', 'sync_status']);
    const expected = Object.keys(fromRegistry).filter((key) => !ledgerOwned.has(key));
    expect(Object.keys(input.row).sort()).toEqual(expected.sort());
  });
});
