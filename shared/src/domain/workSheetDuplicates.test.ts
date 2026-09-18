import { describe, expect, it } from 'vitest';

import {
  buildWorkSheetDuplicateMessage,
  formatWorkSheetDuplicateRef,
  isSameWorkSheetDay,
  moscowDayKey,
  nextWorkSheetPass,
  repeatForPass,
  type WorkSheetDuplicateRef,
} from './workSheetDuplicates.js';

/** 15.09.2026, локальная полночь в MSK = 21:00 UTC 14-го. */
const MSK_15_SEP = Date.UTC(2026, 8, 14, 21, 0, 0);

function ref(over: Partial<WorkSheetDuplicateRef> = {}): WorkSheetDuplicateRef {
  return {
    id: 'row-1',
    typeName: 'Укладка вала в картер',
    at: MSK_15_SEP,
    pass: 1,
    performedBy: null,
    ...over,
  };
}

describe('гейт дублей этапов работ', () => {
  describe('календарный день', () => {
    it('сводит к одному дню метки, которые различаются временем внутри суток', () => {
      // Дата этапа пишется как локальная полночь, но строка истории из карточки двигателя
      // пишет полдень того же дня. Для гейта это один и тот же день.
      const midnight = MSK_15_SEP;
      const noon = MSK_15_SEP + 12 * 3600 * 1000;
      expect(midnight).not.toBe(noon);
      expect(isSameWorkSheetDay(midnight, noon)).toBe(true);
    });

    it('машина в чужой зоне сдвигает день — гейт повторяет то, что видит оператор в списке', () => {
      // Дата пишется как ЛОКАЛЬНАЯ полночь машины (`fromWorkSheetDateInput`), а показывается
      // в московской зоне (`formatMoscowDate`). У машины восточнее MSK «15.09» уезжает на
      // 14.09 — и в списке строка ТОЖЕ покажется четырнадцатым. Это дефект ввода дат, он
      // старше этого гейта и чинится отдельно; здесь важно другое: гейт считает день ровно
      // тем же способом, что и список, поэтому никогда не спорит с тем, что на экране.
      const eastMidnight = Date.UTC(2026, 8, 14, 19, 0, 0); // UTC+5, полночь 15-го
      expect(moscowDayKey(eastMidnight)).toBe('14.09.2026');
      expect(isSameWorkSheetDay(MSK_15_SEP, eastMidnight)).toBe(false);
    });

    it('различает соседние дни', () => {
      expect(isSameWorkSheetDay(MSK_15_SEP, MSK_15_SEP + 24 * 3600 * 1000)).toBe(false);
    });

    it('день считается по московской зоне, а не по зоне машины', () => {
      expect(moscowDayKey(MSK_15_SEP)).toBe('15.09.2026');
    });

  });

  describe('номер прохода', () => {
    it('первый повтор — проход 2', () => {
      expect(nextWorkSheetPass([ref()])).toBe(2);
    });

    it('считается по максимуму, а не по количеству строк', () => {
      // Строку прохода 2 удалили: счёт по количеству выдал бы снова 2 и склеил два возврата.
      expect(nextWorkSheetPass([ref({ pass: 1 }), ref({ id: 'r3', pass: 3 })])).toBe(4);
    });

    it('без строк — первый проход', () => {
      expect(nextWorkSheetPass([])).toBe(2);
    });
  });

  describe('признак повторного прохода', () => {
    it('первый проход признака не несёт', () => {
      expect(repeatForPass(1)).toBeNull();
      expect(repeatForPass(0)).toBeNull();
    });

    it('возврат несёт номер и, если задана, причину', () => {
      expect(repeatForPass(2)).toEqual({ pass: 2 });
      expect(repeatForPass(3, '  замечание ОТК  ')).toEqual({ pass: 3, reason: 'замечание ОТК' });
    });

    it('пустая причина не превращается в пустую строку', () => {
      expect(repeatForPass(2, '   ')).toEqual({ pass: 2 });
    });
  });

  describe('сообщение оператору', () => {
    it('без дублей молчит', () => {
      expect(buildWorkSheetDuplicateMessage({ engineLabel: 'В-55 610A2287', typeName: 'Укладка', at: MSK_15_SEP, refs: [] })).toBeNull();
    });

    it('мусор без id отбрасывается и сообщения не рождает', () => {
      const refs = [{ id: '', typeName: '', at: 0, pass: 1, performedBy: null }];
      expect(buildWorkSheetDuplicateMessage({ engineLabel: 'В-55', typeName: 'Укладка', at: MSK_15_SEP, refs })).toBeNull();
    });

    it('называет двигатель, дату, вид работ и номер будущего прохода', () => {
      const msg = buildWorkSheetDuplicateMessage({
        engineLabel: 'В-55 610A2287',
        typeName: 'Укладка вала в картер',
        at: MSK_15_SEP,
        refs: [ref()],
      });
      expect(msg).not.toBeNull();
      expect(msg!.text).toContain('В-55 610A2287');
      expect(msg!.text).toContain('15.09.2026');
      expect(msg!.text).toContain('Укладка вала в картер');
      expect(msg!.nextPass).toBe(2);
      expect(msg!.text).toContain('№ 2');
    });

    it('предлагает ОБЕ трактовки — и ошибку, и законный возврат', () => {
      const msg = buildWorkSheetDuplicateMessage({
        engineLabel: 'В-55',
        typeName: 'Укладка',
        at: MSK_15_SEP,
        refs: [ref()],
      })!;
      // Гейт не имеет права быть только запретом: возврат на тот же этап — законная ситуация.
      expect(msg.text).toContain('откройте существующую');
      expect(msg.text).toContain('повторный проход');
    });

    it('несколько прежних строк перечисляются все', () => {
      const msg = buildWorkSheetDuplicateMessage({
        engineLabel: 'В-55',
        typeName: 'Укладка',
        at: MSK_15_SEP,
        refs: [ref({ id: 'r1' }), ref({ id: 'r2', pass: 2 })],
      })!;
      expect(msg.text).toContain('2 раза');
      expect(msg.refs).toHaveLength(2);
      expect(msg.nextPass).toBe(3);
    });

    it('строка возврата называется с номером прохода и автором', () => {
      expect(formatWorkSheetDuplicateRef(ref({ pass: 2, performedBy: 'Иванова М.П.' }))).toBe(
        'Укладка вала в картер, 15.09.2026, проход 2, внёс Иванова М.П.',
      );
    });

    it('строка без имени вида работ не превращается в пустое место', () => {
      expect(formatWorkSheetDuplicateRef(ref({ typeName: '   ' }))).toContain('этап работ');
    });
  });
});
