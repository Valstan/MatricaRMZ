import { describe, expect, it } from 'vitest';

import { sanitizeUserUiProfile } from './userUiProfile.js';

// Секции профиля, которыми отчёты ездят за пользователем (журнал построений и личные
// «Мои отчёты»). Санитайзер зовётся и на чтении, и на записи: пропустив мусор, он разнёс
// бы его по всем машинам владельца, а срезав лишнее — стёр бы чужую работу.
describe('секция журнала отчётов в профиле', () => {
  it('несёт настройки, число строк и счётчик повторов', () => {
    const out = sanitizeUserUiProfile({
      reportHistory: [
        { presetId: 'engines', title: 'Двигатели', generatedAt: 1788210000000, filters: { startMs: 1 }, disabled: ['period'], rowCount: 7, times: 3 },
      ],
    });
    expect(out.reportHistory).toEqual([
      { presetId: 'engines', title: 'Двигатели', generatedAt: 1788210000000, filters: { startMs: 1 }, disabled: ['period'], rowCount: 7, times: 3 },
    ]);
  });

  it('записи без пресета или без времени отбрасываются', () => {
    const out = sanitizeUserUiProfile({
      reportHistory: [
        { presetId: '', title: 'x', generatedAt: 5 },
        { presetId: 'engines', title: 'x', generatedAt: 0 },
        { presetId: 'engines', title: 'Двигатели', generatedAt: 10 },
      ],
    });
    expect(out.reportHistory).toHaveLength(1);
    expect(out.reportHistory?.[0]?.presetId).toBe('engines');
  });

  it('единичный счётчик не хранится, а заголовок подменяется пресетом', () => {
    const out = sanitizeUserUiProfile({ reportHistory: [{ presetId: 'engines', title: '  ', generatedAt: 10, times: 1 }] });
    expect(out.reportHistory?.[0]?.times).toBeUndefined();
    expect(out.reportHistory?.[0]?.title).toBe('engines');
  });

  it('не массив — секции нет вовсе (её не затрут пустотой)', () => {
    expect(sanitizeUserUiProfile({ reportHistory: { a: 1 } }).reportHistory).toBeUndefined();
  });
});

describe('секция «Моих отчётов» в профиле', () => {
  it('берёт шаблон со спекой как есть', () => {
    const out = sanitizeUserUiProfile({
      customReportTemplates: [{ id: 't1', name: 'Сверка с бухгалтерией', createdAt: 100, spec: { version: 1, sourcePresetId: 'engines' } }],
    });
    expect(out.customReportTemplates).toEqual([
      { id: 't1', name: 'Сверка с бухгалтерией', createdAt: 100, spec: { version: 1, sourcePresetId: 'engines' } },
    ]);
  });

  it('без имени, без id или без объекта-спеки шаблон не едет', () => {
    const out = sanitizeUserUiProfile({
      customReportTemplates: [
        { id: '', name: 'без id', spec: {} },
        { id: 't2', name: '', spec: {} },
        { id: 't3', name: 'без спеки' },
        { id: 't4', name: 'спека массивом', spec: [] },
        { id: 't5', name: 'годный', spec: { version: 1 } },
      ],
    });
    expect(out.customReportTemplates?.map((t) => t.id)).toEqual(['t5']);
  });

  it('раздутая спека отбрасывается, а не тащит за собой весь профиль', () => {
    const huge = { version: 1, note: 'x'.repeat(9000) };
    const out = sanitizeUserUiProfile({ customReportTemplates: [{ id: 't1', name: 'толстый', spec: huge }] });
    expect(out.customReportTemplates).toEqual([]);
  });
});
