import { describe, expect, it } from 'vitest';

import {
  ENGINE_SCRAP_ROW_BACKGROUND,
  ENGINE_SCRAP_ROW_BACKGROUND_PRINT,
  engineScrapById,
  engineScrapFlagsById,
  engineScrapRowBackgroundPrint,
  engineScrapRowStyle,
} from './engineScrap.js';

describe('пометка строки утильного двигателя', () => {
  it('утильный двигатель — розовая строка, обычный — без фона', () => {
    expect(engineScrapRowStyle(true)).toEqual({ background: ENGINE_SCRAP_ROW_BACKGROUND });
    expect(engineScrapRowStyle(false)).toEqual({});
    // Признак неизвестен — строки не красим (пустое поле ≠ «утиль»).
    expect(engineScrapRowStyle(null)).toEqual({});
    expect(engineScrapRowStyle(undefined)).toEqual({});
  });

  it('цвет на экране совпадает с основным списком двигателей', () => {
    // Основной список: EnginesPage — `background: 'rgba(239, 68, 68, 0.18)'`.
    expect(ENGINE_SCRAP_ROW_BACKGROUND).toBe('rgba(239, 68, 68, 0.18)');
  });

  it('для печати — плотный розовый: на белом фоне полупрозрачный бледнеет', () => {
    expect(ENGINE_SCRAP_ROW_BACKGROUND_PRINT).toBe('#fde8e8');
    expect(engineScrapRowBackgroundPrint(true)).toBe('#fde8e8');
    expect(engineScrapRowBackgroundPrint(false)).toBeUndefined();
    expect(engineScrapRowBackgroundPrint(null)).toBeUndefined();
  });
});

describe('признак утиля из каталога двигателей', () => {
  it('карта строится по id и несёт готовый признак списка', () => {
    const flags = engineScrapFlagsById([
      { id: 'e1', isScrap: true },
      { id: 'e2', isScrap: false },
      { id: 'e3' },
    ]);
    expect(engineScrapById(flags, 'e1')).toBe(true);
    expect(engineScrapById(flags, 'e2')).toBe(false);
    // Признак неизвестен — не утиль (пустое поле ≠ «утиль»).
    expect(engineScrapById(flags, 'e3')).toBe(false);
  });

  it('двигателя нет в каталоге — не утиль, пустой каталог не ломает правило', () => {
    expect(engineScrapById(engineScrapFlagsById([]), 'e1')).toBe(false);
    expect(engineScrapById(engineScrapFlagsById(null), 'e1')).toBe(false);
    expect(engineScrapById(null, 'e1')).toBe(false);
    expect(engineScrapById(engineScrapFlagsById([{ id: 'e1', isScrap: true }]), null)).toBe(false);
  });
});
