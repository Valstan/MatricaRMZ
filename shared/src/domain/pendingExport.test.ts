import { describe, expect, it } from 'vitest';

import {
  formatPendingExportReport,
  pendingExportReasonText,
  type PendingExportSummary,
} from './pendingExport.js';

const SUMMARY: PendingExportSummary = {
  files: [
    { name: 'pending-export-2026-11-23T10-00-00-000Z.json', rows: 12, exportedAt: 1_700_000_000_000, reason: 'schema_mismatch' },
    { name: 'pending-export-2026-11-23T11-00-00-000Z.json', rows: 3, exportedAt: 1_700_003_600_000, reason: 'schema_mismatch' },
  ],
  rows: 15,
  byTable: [
    { table: 'entities', n: 10 },
    { table: 'attribute_values', n: 5 },
  ],
  oldestExportedAt: 1_700_000_000_000,
  reason: 'schema_mismatch',
};

describe('причина выгрузки', () => {
  it('известная причина называется словами', () => {
    expect(pendingExportReasonText('schema_mismatch')).toContain('расхождение схемы');
    expect(pendingExportReasonText('ui')).toContain('по команде оператора');
  });

  it('неизвестная не выдумывается — называется как есть', () => {
    expect(pendingExportReasonText('что-то новое')).toBe('что-то новое');
  });

  it('отсутствующая причина честно помечена как неизвестная', () => {
    expect(pendingExportReasonText(null)).toBe('причина не указана');
  });
});

describe('отчёт администратору', () => {
  const text = formatPendingExportReport({
    clientId: 'client-1',
    summary: SUMMARY,
    appVersion: '3.143.0',
    detectedAt: 1_700_003_600_000,
  });

  it('называет объём и то, что данных нет на сервере', () => {
    expect(text).toContain('15 шт.');
    expect(text).toContain('На сервере этих данных нет');
  });

  it('перечисляет файлы — оператор приложит их к отчёту', () => {
    expect(text).toContain('pending-export-2026-11-23T10-00-00-000Z.json');
    expect(text).toContain('pending-export-2026-11-23T11-00-00-000Z.json');
  });

  it('потабличный разбор доезжает до отчёта — видно, ЧТО именно не уехало', () => {
    expect(text).toContain('entities: 10');
    expect(text).toContain('attribute_values: 5');
  });

  it('называет машину, причину и версию программы', () => {
    expect(text).toContain('client-1');
    expect(text).toContain('расхождение схемы');
    expect(text).toContain('3.143.0');
  });

  it('значений строк в отчёте нет — только имена файлов, таблицы и количества', () => {
    // ПДн наружу не идут (D-041): в отчёте нет ни одного значения строки.
    expect(text).not.toContain('id=');
    expect(text).not.toContain('engineNumber');
  });

  it('пустой разбор не ломает отчёт', () => {
    const empty = formatPendingExportReport({
      clientId: 'client-1',
      summary: { files: [{ name: 'pending-export-x.json', rows: 0, exportedAt: null, reason: null }], rows: 0, byTable: [], oldestExportedAt: null, reason: null },
    });
    expect(empty).toContain('client-1');
    expect(empty).toContain('pending-export-x.json');
  });
});
