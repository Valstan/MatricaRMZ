import { describe, expect, it } from 'vitest';

import { describeAuditAction } from './auditAction.js';

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

  it('подписывает коды, которые прежде уходили в хвостовой фолбэк кодом', () => {
    expect(describeAuditAction({ action: 'ui.visit', actionType: 'other' })).toBe('Открыл раздел');
    expect(describeAuditAction({ action: 'ui.report_build', actionType: 'other' })).toBe('Построил отчёт');
    expect(describeAuditAction({ action: 'work_order.number_change', actionType: 'other' })).toBe(
      'Сменил номер наряда',
    );
  });

  it('никогда не показывает служебный код, даже когда подписи нет', () => {
    const text = describeAuditAction({ action: 'нечто.невиданное', actionType: 'other' });
    expect(text).toBe('Выполнил действие');
    expect(text).not.toContain('нечто.невиданное');
  });

  it('серверную формулировку, не входящую в общий набор, показывает как есть', () => {
    expect(
      describeAuditAction({ action: 'x.update', actionText: 'Изменил количество на 5', actionType: 'update' }),
    ).toBe('Изменил количество на 5');
  });

  it('общую серверную формулировку заменяет подписью по разделу', () => {
    expect(
      describeAuditAction({ action: 'x.update', actionText: 'Изменил запись', section: 'Детали', actionType: 'update' }),
    ).toBe('Редактировал деталь в «Детали»');
  });

  // Панель истории документа не знает tableName/entityId — тип обязан их не требовать.
  it('принимает урезанную строку панели истории документа', () => {
    expect(
      describeAuditAction({
        action: 'ui.card_open',
        actionText: '',
        section: 'Двигатели',
        documentLabel: 'Д-100',
        actionType: 'other',
      }),
    ).toBe('Открыл карточку «Д-100»');
  });
});
