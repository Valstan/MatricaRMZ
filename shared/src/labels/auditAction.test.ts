import { describe, expect, it } from 'vitest';

import { describeAuditAction } from './auditAction.js';

/**
 * Строки собраны в БОЕВОЙ форме. Это важно: колонка `section` объявлена NOT NULL, а сервер
 * для нераспознанного действия кладёт туда «Прочее» — то есть раздел приходит непустым
 * ВСЕГДА. Тест, опускающий `section`, проверяет форму, которой API не производит, и прячет
 * ровно те дефекты, ради которых он написан.
 */
describe('describeAuditAction', () => {
  it('переводит коды статусов заявки, а не печатает их', () => {
    expect(
      describeAuditAction({
        action: 'supply_request.transition',
        actionText: 'Изменил статус заявки: draft -> signed',
        section: 'Заявки',
        documentLabel: 'Заявка №12',
        actionType: 'update',
      }),
    ).toBe('Сменил статус заявки по «Заявка №12»: Черновик → Подписана начальником цеха');
  });

  // Панель истории документа печатала серверный actionText как есть, а он для этих кодов
  // равен самому коду: оператор видел «ui.card_open» в столбце «Действие».
  it('подписывает коды, для которых сервер кладёт в текст сам код', () => {
    expect(describeAuditAction({ action: 'ui.visit', actionText: 'ui.visit', section: 'Прочее', actionType: 'other' })).toBe(
      'Открыл раздел',
    );
    expect(
      describeAuditAction({
        action: 'ui.report_build',
        actionText: 'ui.report_build',
        section: 'Прочее',
        actionType: 'other',
      }),
    ).toBe('Построил отчёт');
    expect(
      describeAuditAction({
        action: 'work_order.number_change',
        actionText: 'work_order.number_change',
        section: 'Прочее',
        actionType: 'other',
      }),
    ).toBe('Сменил номер наряда');
  });

  // «Прочее» — не раздел, а признак его отсутствия; дописывать «в «Прочее»» бессмысленно.
  it('не приписывает к подписи раздел-заглушку', () => {
    const text = describeAuditAction({ action: 'ui.visit', actionText: 'ui.visit', section: 'Прочее', actionType: 'other' });
    expect(text).not.toContain('Прочее');
  });

  it('никогда не показывает служебный код, даже когда подписи нет', () => {
    const text = describeAuditAction({
      action: 'нечто.невиданное',
      actionText: 'нечто.невиданное',
      section: 'Прочее',
      actionType: 'other',
    });
    expect(text).toBe('Выполнил действие');
    expect(text).not.toContain('нечто.невиданное');
  });

  /**
   * Регресс, пойманный ревью: таблица точных кодов перехватывала `.edit_done` раньше ветки,
   * которая дописывает перечень изменённых полей, и панель истории документа — единственный
   * потребитель, который этот перечень показывал, — теряла его целиком.
   */
  it('сохраняет перечень изменённых полей у правки карточки', () => {
    expect(
      describeAuditAction({
        action: 'ui.engine.edit_done',
        actionText: 'Изменил карточку двигателя. Изменил: Марка, Дата прихода',
        section: 'Двигатели',
        documentLabel: 'Д-100',
        actionType: 'update',
      }),
    ).toBe('Редактировал двигатель «Д-100». Изменил: Марка, Дата прихода');
  });

  it('правка без перечня полей не превращается в оборванную фразу', () => {
    expect(
      describeAuditAction({
        action: 'ui.supply_request.edit_done',
        actionText: 'Изменил заявку',
        section: 'Заявки',
        documentLabel: 'Заявка №7',
        actionType: 'update',
      }),
    ).toBe('Редактировал заявку «Заявка №7»');
  });

  it('серверную формулировку, не входящую в общий набор, показывает как есть', () => {
    expect(
      describeAuditAction({
        action: 'x.update',
        actionText: 'Изменил количество на 5',
        section: 'Прочее',
        actionType: 'update',
      }),
    ).toBe('Изменил количество на 5');
  });

  it('общую серверную формулировку заменяет подписью по разделу', () => {
    expect(
      describeAuditAction({ action: 'x.update', actionText: 'Изменил запись', section: 'Детали', actionType: 'update' }),
    ).toBe('Редактировал деталь в «Детали»');
  });

  // Панель истории документа не знает tableName/entityId — тип обязан их не требовать.
  // Заодно сторож против обеднения: у открытия карточки есть и вид карточки, и раздел,
  // и общая подпись в таблице точных кодов их бы потеряла.
  it('принимает урезанную строку панели истории документа и не теряет вид карточки', () => {
    expect(
      describeAuditAction({
        action: 'ui.card_open',
        actionText: 'ui.card_open',
        section: 'Двигатели',
        documentLabel: 'Д-100',
        actionType: 'other',
      }),
    ).toBe('Открыл карточку двигателя «Д-100» в «Двигатели»');
  });
});
