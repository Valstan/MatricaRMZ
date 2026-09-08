import { describe, expect, it } from 'vitest';

import { computeStatus, foldSkippedRowsSnapshots } from '../services/diagnosticsSyncPipelineService.js';

// Снимок пропусков пишется на каждый push с пропуском (applyPushBatch).
const snapshot = (metrics: unknown[]) => JSON.stringify({ kind: 'sync_skipped_rows', at: 1, actor: 'oper', metrics });

const dependencyMetric = (rowIds: string[], count = rowIds.length) => ({
  kind: 'dependency',
  table: 'operations',
  dependency: 'engine_entity',
  count,
  rowIds,
});

describe('foldSkippedRowsSnapshots', () => {
  it('один клиент, повторяющий те же строки, даёт число строк — а не число попыток', () => {
    // 400 push-ов по 2 строки: было бы 800 «пропущенных строк» и вечный critical
    // при пороге 500 — ровно случай PC19 (8 строк × ~800 попыток в сутки).
    const payloads = Array.from({ length: 400 }, () => snapshot([dependencyMetric(['op-1', 'op-2'])]));
    const fold = foldSkippedRowsSnapshots(payloads);
    expect(fold.dependency).toBe(2);
    expect(fold.dependencyAttempts).toBe(800);
    expect(fold.byTable.operations?.dependency).toBe(2);
    expect(computeStatus({ indexToProjectionLag: 0, maxTableRatio: 0, skippedDependencyRows24h: fold.dependency })).toBe('ok');
    expect(computeStatus({ indexToProjectionLag: 0, maxTableRatio: 0, skippedDependencyRows24h: fold.dependencyAttempts })).toBe(
      'critical',
    );
  });

  it('разные строки складываются — настоящий массовый пропуск гейт по-прежнему видит', () => {
    const payloads = Array.from({ length: 600 }, (_, i) => snapshot([dependencyMetric([`op-${i}`])]));
    const fold = foldSkippedRowsSnapshots(payloads);
    expect(fold.dependency).toBe(600);
    expect(computeStatus({ indexToProjectionLag: 0, maxTableRatio: 0, skippedDependencyRows24h: fold.dependency })).toBe('critical');
  });

  it('строки разных таблиц не смешиваются', () => {
    const fold = foldSkippedRowsSnapshots([
      snapshot([dependencyMetric(['row-1'])]),
      snapshot([{ kind: 'dependency', table: 'entities', dependency: 'entity_type', count: 1, rowIds: ['row-1'] }]),
    ]);
    expect(fold.dependency).toBe(2);
    expect(fold.byTable.operations?.dependency).toBe(1);
    expect(fold.byTable.entities?.dependency).toBe(1);
  });

  it('старые снимки без rowIds считаются попытками — сутки после выката гейт не слепнет', () => {
    const fold = foldSkippedRowsSnapshots([
      snapshot([{ kind: 'dependency', table: 'operations', dependency: 'engine_entity', count: 8 }]),
      snapshot([dependencyMetric(['op-1'])]),
    ]);
    expect(fold.dependency).toBe(9);
    expect(fold.dependencyAttempts).toBe(9);
  });

  it('конфликты считаются по-старому и в число строк зависимостей не попадают', () => {
    const fold = foldSkippedRowsSnapshots([
      snapshot([
        { kind: 'conflict', table: 'operations', dependency: null, count: 3 },
        dependencyMetric(['op-1']),
      ]),
    ]);
    expect(fold.conflict).toBe(3);
    expect(fold.dependency).toBe(1);
    expect(fold.byTable.operations).toEqual({ dependency: 1, conflict: 3 });
  });

  it('мусор в снимке не роняет свёртку', () => {
    const fold = foldSkippedRowsSnapshots([null, undefined, '', 'не json', '{"kind":"other"}', snapshot([dependencyMetric(['op-1'])])]);
    expect(fold.dependency).toBe(1);
  });
});
