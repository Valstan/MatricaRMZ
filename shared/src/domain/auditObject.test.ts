import { describe, expect, it } from 'vitest';

import {
  AUDIT_OBJECT_KIND_BY_CARD_KEY,
  auditObjectKindForRow,
  auditObjectNameFromPayload,
  auditObjectRestorePath,
  auditSectionForAction,
  auditSectionForObjectKind,
  auditSectionForRow,
  auditSectionForTabKey,
} from './auditObject.js';
import { CARD_TAB_KEYS } from './uiSections.js';

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

  it('открытие карточки называет раздел по ключу карточки', () => {
    // `payload.label` при `ui.card_open` — это `TabId` карточки, то есть тот же ключ,
    // что и у вкладки. Раньше четыре вида карточек не знались разделом вовсе, и их строки
    // падали в «Прочее» («Выполнил действие») — замер на живых данных, 57 строк.
    expect(auditSectionForRow({ action: 'ui.card_open', cardKey: 'ppe_card' })).toBe('Карточки СИЗ');
    expect(auditSectionForRow({ action: 'ui.card_open', cardKey: 'nomenclature_item' })).toBe('Номенклатура');
    expect(auditSectionForRow({ action: 'ui.card_open', cardKey: 'work_sheet' })).toBe('Этапы ремонта');
    expect(auditSectionForRow({ action: 'ui.card_open', cardKey: 'stock_document' })).toBe('Документы');
  });

  it('неизвестный ключ вкладки раздел не выдумывает', () => {
    // `sectionLabelForTabKey` для неизвестного ключа возвращает «ключ» в кавычках —
    // это не раздел, и в журнал он попасть не должен.
    expect(auditSectionForRow({ action: 'ui.visit', tabKey: 'такого-раздела-нет' })).toBe('');
    expect(auditSectionForTabKey('такого-раздела-нет')).toBe('');
    expect(auditSectionForTabKey('engines')).toBe('Двигатели');
  });

  it('названия разделов совпадают с вкладками программы', () => {
    // Иначе фильтр по разделу в журнале покажет «Договоры» и «Контракты» как два
    // разных раздела — а объект лежит в одном.
    expect(auditSectionForObjectKind('contract')).toBe('Контракты');
    expect(auditSectionForObjectKind('stock_document')).toBe('Документы');
    expect(auditSectionForObjectKind('tool_property')).toBe('Инструменты');
  });

  it('неизвестный код не выдумывает раздел', () => {
    expect(auditSectionForAction('что.то.неизвестное')).toBe('');
  });

  it('каждая карточка программы названа разделом в журнале', () => {
    // Клиент пишет в журнал ключ карточки (`payload.label`), а не название раздела.
    // Если ключ не знается правилу — строка падает в «Прочее» («Выполнил действие»).
    // На живых данных так были 57 строк: карточки СИЗ, номенклатуры, листа ремонта
    // и документа склада.
    const unknown: string[] = [];
    for (const key of CARD_TAB_KEYS) {
      if (!auditSectionForRow({ action: 'ui.card_open', cardKey: key })) unknown.push(key);
    }
    expect(unknown, 'карточки без раздела в журнале').toEqual([]);
  });

  it('вид карточки известен правилу для каждой карточки программы', () => {
    const unknown: string[] = [];
    for (const key of CARD_TAB_KEYS) {
      if (!AUDIT_OBJECT_KIND_BY_CARD_KEY[key]) unknown.push(key);
    }
    expect(unknown, 'вид карточки без правила').toEqual([]);
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
