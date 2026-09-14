import { describe, expect, it } from 'vitest';

import { decideHeaderFix } from './fixEngineActHeaderNumber20260914.js';

/**
 * Проход правит ЖИВЫЕ данные прода, и вся его безопасность держится на одной функции: она
 * отделяет след дефекта (пусто или обрезано) от того, что оператор вписал руками. Ошибись она
 * в сторону «правим» — проход затрёт операторские номера на сотнях листов, и откат будет
 * возможен только из бэкапа.
 */
describe('decideHeaderFix', () => {
  it('пустую шапку заполняет номером из карточки', () => {
    expect(decideHeaderFix({ stored: '', card: '2Ж03АТ' }).action).toBe('fill');
    expect(decideHeaderFix({ stored: '   ', card: '2Ж03АТ' }).action).toBe('fill');
  });

  it('обрезанный номер дотягивает до полного — это и есть след дефекта', () => {
    expect(decideHeaderFix({ stored: '2', card: '2Ж03АТ' }).action).toBe('extend');
    expect(decideHeaderFix({ stored: '2Ж03', card: '2Ж03АТ' }).action).toBe('extend');
  });

  it('регистр и пробелы по краям не мешают опознать префикс', () => {
    expect(decideHeaderFix({ stored: '2ж', card: '2Ж03АТ' }).action).toBe('extend');
    expect(decideHeaderFix({ stored: ' 2Ж ', card: '2Ж03АТ' }).action).toBe('extend');
  });

  it('своё значение оператора не трогает', () => {
    expect(decideHeaderFix({ stored: 'без номера', card: '2Ж03АТ' }).action).toBe('skip');
    // Не префикс, хотя и похоже: другой двигатель той же серии.
    expect(decideHeaderFix({ stored: '2Ж04АТ', card: '2Ж03АТ' }).action).toBe('skip');
    // Длиннее карточки — оператор дописал, а не мы обрезали.
    expect(decideHeaderFix({ stored: '2Ж03АТ-1', card: '2Ж03АТ' }).action).toBe('skip');
  });

  it('молчит, когда править нечем или нечего', () => {
    expect(decideHeaderFix({ stored: '2Ж03АТ', card: '2Ж03АТ' }).action).toBe('skip');
    expect(decideHeaderFix({ stored: '2Ж03ат', card: '2Ж03АТ' }).action).toBe('skip');
    expect(decideHeaderFix({ stored: 'что угодно', card: '' }).action).toBe('skip');
    expect(decideHeaderFix({ stored: '', card: '' }).action).toBe('skip');
  });
});
