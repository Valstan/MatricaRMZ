import { describe, expect, it } from 'vitest';

import { buildConvertedMetaJson, decideKittingRow } from './mergeKittingToArrival.js';
import { canonicalStageMetaJson } from './refreshStageNames.js';
import { PR3_CANONICAL_STAGE_NAMES } from './pr3StageNames.js';
import { camelOperationRowForSync } from './pr3SyncRow.js';
import {
  buildRepairHistoryMeta,
  REPAIR_STAGE_CODES,
  SyncTableName,
  SyncTableRegistry,
  syncRowSchemaByTable,
} from '@matricarmz/shared';

// PR3 данные: слияние kitting→arrival и обновление имён (чистые функции).

describe('frozen canonical map', () => {
  it('покрывает ровно реестр (kitting снесён — его здесь нет)', () => {
    expect(Object.keys(PR3_CANONICAL_STAGE_NAMES).sort()).toEqual([...REPAIR_STAGE_CODES].sort());
  });
});

describe('camelOperationRowForSync', () => {
  it('сырая pg-строка (snake, bigint строкой) через toSyncRow проходит валидатор операций', () => {
    const raw = {
      id: '11111111-1111-4111-8111-111111111111',
      engine_entity_id: '22222222-2222-4222-8222-222222222222',
      operation_type: 'repair_history_entry',
      status: 'done',
      note: 'Этап: Сборка',
      performed_at: '1791147600000',
      performed_by: 'tester',
      meta_json: '{"kind":"repair_history"}',
      created_at: '1791147600001',
      updated_at: '1791147600002',
      last_server_seq: null,
      deleted_at: null,
      sync_status: 'synced',
    };
    const dto = SyncTableRegistry.toSyncRow(SyncTableName.Operations, camelOperationRowForSync(raw));
    expect(syncRowSchemaByTable[SyncTableName.Operations].safeParse(dto).success).toBe(true);
  });
});

describe('decideKittingRow', () => {
  it('есть arrival — гасим kitting (дубль)', () => {
    expect(decideKittingRow(true)).toBe('delete');
  });

  it('arrival нет — переписываем kitting в arrival (дата сохраняется)', () => {
    expect(decideKittingRow(false)).toBe('convert');
  });
});

describe('buildConvertedMetaJson', () => {
  it('код/подписи — arrival, id/даты/проход untouched', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Комплектовка сделана',
      auto: true,
      at: 1000,
      entryType: 'stage',
      stage: { code: 'kitting_done', name: 'Комплектовка сделана' },
      repeat: { pass: 2 },
    });
    const next = JSON.parse(buildConvertedMetaJson(JSON.stringify(meta)));
    expect(next.stage).toEqual({ code: 'arrival', name: 'Приемка двигателя на завод' });
    expect(next.action).toBe('Приемка двигателя на завод');
    expect(next.at).toBe(1000);
    expect(next.repeat).toEqual({ pass: 2 });
    expect(next.entryType).toBe('stage');
    expect(next.auto).toBe(true);
  });

  it('не kitting — отказ (решение устарело)', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Сборка',
      entryType: 'stage',
      stage: { code: 'sborka', name: 'Сборка' },
    });
    expect(() => buildConvertedMetaJson(JSON.stringify(meta))).toThrow();
  });
});

describe('canonicalStageMetaJson', () => {
  it('старое имя — переписывает action и stage.name, остальное untouched', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Сборка',
      auto: true,
      at: 2000,
      entryType: 'stage',
      stage: { code: 'sborka', name: 'Сборка' },
      note: 'заметка оператора',
    });
    const next = canonicalStageMetaJson(JSON.stringify(meta));
    expect(next).not.toBeNull();
    const parsed = JSON.parse(next!);
    expect(parsed.action).toBe('Сборка двигателя');
    expect(parsed.stage).toEqual({ code: 'sborka', name: 'Сборка двигателя' });
    expect(parsed.at).toBe(2000);
    expect(parsed.auto).toBe(true);
    expect(parsed.note).toBe('заметка оператора');
  });

  it('уже канон — null (записи нет)', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Сборка двигателя',
      entryType: 'stage',
      stage: { code: 'sborka', name: 'Сборка двигателя' },
    });
    expect(canonicalStageMetaJson(JSON.stringify(meta))).toBeNull();
  });

  it('чужой код и не-stage — null', () => {
    const kitting = buildRepairHistoryMeta({
      action: 'Комплектовка сделана',
      entryType: 'stage',
      stage: { code: 'kitting_done', name: 'Комплектовка сделана' },
    });
    expect(canonicalStageMetaJson(JSON.stringify(kitting))).toBeNull();
    expect(canonicalStageMetaJson(JSON.stringify({ kind: 'repair_history', action: 'Своё' }))).toBeNull();
    expect(canonicalStageMetaJson('не json')).toBeNull();
  });
});
