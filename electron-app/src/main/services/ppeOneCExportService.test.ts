/**
 * Выгрузка СИЗ для 1С: структура колонок и содержимое файла.
 *
 * Файл читает бухгалтер и загружает в 1С — поэтому важны две вещи: фиксированный
 * порядок колонок (он не должен «плыть» вместе с настройками экрана) и отсутствие
 * служебных идентификаторов в данных.
 */
import { describe, expect, it } from 'vitest';

import {
  buildPpeOneCNormsCsv,
  buildPpeOneCIssuesCsv,
  PPE_ONE_C_ISSUE_COLUMNS,
  PPE_ONE_C_NORM_COLUMNS,
} from './ppeOneCExportService.js';

const NORM_ROW = {
  personnelNo: '0042',
  fullName: 'Иванов Иван Иванович',
  postTitle: 'Кладовщик',
  departmentName: 'Склад',
  itemName: 'Костюм для защиты от механических воздействий (истирания)',
  sourceLabel: 'Пункт № 1511',
  ppeType: 'Одежда специальная защитная',
  unit: 'шт.',
  qty: 1,
  wearPeriod: '12 мес.',
  size: '50',
};

const ISSUE_ROW = {
  personnelNo: '0042',
  fullName: 'Иванов Иван Иванович',
  postTitle: 'Кладовщик',
  departmentName: 'Склад',
  itemName: 'Костюм зимний, р. 50',
  size: '50',
  qty: 1,
  issuedAt: Date.UTC(2026, 10, 2),
  documentNo: 'РМЗ-000123',
  wearPeriod: '24 мес.',
};

describe('ppe: выгрузка для 1С', () => {
  it('структура норм — фиксированная и осмысленная', () => {
    expect(PPE_ONE_C_NORM_COLUMNS).toEqual([
      'Табельный номер',
      'ФИО',
      'Должность',
      'Подразделение',
      'Наименование СИЗ',
      'Пункт ТОН',
      'Тип СИЗ',
      'Ед. изм.',
      'Кол-во на год',
      'Срок носки',
      'Размер',
    ]);
  });

  it('структура выдачи — фиксированная и осмысленная', () => {
    expect(PPE_ONE_C_ISSUE_COLUMNS).toEqual([
      'Табельный номер',
      'ФИО',
      'Должность',
      'Подразделение',
      'Наименование СИЗ',
      'Размер',
      'Кол-во',
      'Дата выдачи',
      'Основание (документ)',
      'Срок службы',
    ]);
  });

  it('CSV норм: заголовок и строка данных на месте', () => {
    const csv = buildPpeOneCNormsCsv({ rows: [NORM_ROW] }).toString('utf8');
    const lines = csv.split('\r\n').filter((l) => l !== '');
    expect(lines[0]).toBe(PPE_ONE_C_NORM_COLUMNS.join(';'));
    expect(lines[1]).toContain('Иванов Иван Иванович');
    expect(lines[1]).toContain('Пункт № 1511');
    expect(lines[1]).toContain('Костюм для защиты от механических воздействий (истирания)');
  });

  it('CSV выдачи: дата в формате ДД.ММ.ГГГГ', () => {
    const csv = buildPpeOneCIssuesCsv({ rows: [ISSUE_ROW] }).toString('utf8');
    const lines = csv.split('\r\n').filter((l) => l !== '');
    expect(lines[0]).toBe(PPE_ONE_C_ISSUE_COLUMNS.join(';'));
    expect(lines[1]).toContain('02.11.2026');
    expect(lines[1]).toContain('РМЗ-000123');
  });

  it('служебных идентификаторов (uuid) в данных нет', () => {
    const csv = buildPpeOneCNormsCsv({ rows: [NORM_ROW] }).toString('utf8');
    expect(csv).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('точки и запятые в тексте не ломают CSV', () => {
    const csv = buildPpeOneCNormsCsv({
      rows: [{ ...NORM_ROW, itemName: 'Костюм, «утеплённый»; модель 1' }],
    }).toString('utf8');
    const line = csv.split('\r\n')[1] ?? '';
    // Значение с запятой и кавычками оборачивается в кавычки — разделитель не путается.
    expect(line).toContain('"');
  });

  it('пустой список даёт только заголовок', () => {
    const csv = buildPpeOneCNormsCsv({ rows: [] }).toString('utf8');
    const lines = csv.split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(PPE_ONE_C_NORM_COLUMNS.join(';'));
  });
});
