import { describe, expect, it } from 'vitest';

import {
  auditObjectKindForRow,
  auditObjectNameFromPayload,
  auditObjectRestorePath,
  auditSectionForAction,
  auditSectionForObjectKind,
  auditSectionForRow,
} from './auditObject.js';

/**
 * Правило «журнал называет конкретный объект» (промт КАРМАНА #169).
 * Строки собраны в боевой форме: раздел приходит непустым ВСЕГДА (сервер кладёт «Прочее»,
 * если не нашёл раздела).
 */
describe('раздел строки журнала', () => {
  it('раздел берётся по коду действия', () => {
    expect(auditSectionForAction('engine.create')).toBe('Двигатели');
    expect(auditSectionForAction('supply_request.update')).toBe('Заявки');
    expect(auditSectionForAction('employee.delete')).toBe('Сотрудники');
    expect(auditSectionForAction('work_order.number_change')).toBe('Наряды');
    expect(auditSectionForAction('files.create')).toBe('Файлы');
    expect(auditSectionForAction('app.session.start')).toBe('Сессия приложения');
  });

  it('клиентские коды открытия карточек не попадают в «Прочее»', () => {
    // `ui.card_open` приходит без префикса вида: раздел определяется по типу объекта.
    expect(auditSectionForAction('ui.card_open')).toBe('');
    expect(auditSectionForRow({ action: 'ui.card_open', tableName: 'erp_engine_cards' })).toBe('Двигатели');
    expect(auditSectionForRow({ action: 'ui.card_open', cardKey: 'counterparty' })).toBe('Контрагенты');
  });

  it('визит вкладки называет раздел по ключу вкладки', () => {
    expect(auditSectionForRow({ action: 'ui.visit', tabKey: 'engines' })).toBe('Двигатели');
    expect(auditSectionForRow({ action: 'ui.visit', tabKey: 'audit' })).toBe('Журнал');
  });

  it('неизвестный код не выдумывает раздел', () => {
    expect(auditSectionForAction('что.то.неизвестное')).toBe('');
  });
});

describe('имя объекта в строке журнала', () => {
  it('берётся из payload — номер важнее наименования', () => {
    expect(auditObjectNameFromPayload({ engineNumber: 'Д-100', name: 'Деталь' })).toBe('Д-100');
    expect(auditObjectNameFromPayload({ requestNumber: 'Заявка №7' })).toBe('Заявка №7');
    expect(auditObjectNameFromPayload({ docNo: 'ТД-12' })).toBe('ТД-12');
    expect(auditObjectNameFromPayload({ name: 'Болт М12' })).toBe('Болт М12');
  });

  it('пустой payload не даёт выдуманного имени', () => {
    expect(auditObjectNameFromPayload(null)).toBe('');
    expect(auditObjectNameFromPayload({})).toBe('');
    expect(auditObjectNameFromPayload({ engineNumber: '   ' })).toBe('');
  });
});

describe('вид объекта строки журнала', () => {
  it('определяется по таблице и по ключу карточки', () => {
    expect(auditObjectKindForRow({ tableName: 'erp_engine_cards' })).toBe('engine');
    expect(auditObjectKindForRow({ tableName: 'erp_contracts' })).toBe('contract');
    expect(auditObjectKindForRow({ tableName: 'erp_counterparties' })).toBe('counterparty');
    expect(auditObjectKindForRow({ cardKey: 'request' })).toBe('supply_request');
  });

  it('EAV-таблица сама по себе вида не даёт — вид знает тип сущности', () => {
    // `entities` под всеми типами сразу: назвать вид по имени таблицы нельзя.
    expect(auditObjectKindForRow({ tableName: 'entities' })).toBeNull();
  });
});

describe('путь возврата объекта', () => {
  it('показывает раздел и имя — оператор видит, что вернёт и куда', () => {
    expect(auditObjectRestorePath('Двигатели', 'Д-100')).toBe('Двигатели → Д-100');
    expect(auditSectionForObjectKind('engine')).toBe('Двигатели');
  });
});
