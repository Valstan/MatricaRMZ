import { describe, expect, it } from 'vitest';

import {
  ENGINE_SCRAP_ROW_BACKGROUND,
  ENGINE_SCRAP_ROW_BACKGROUND_PRINT,
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
  });
});
