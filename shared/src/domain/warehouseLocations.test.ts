import { describe, expect, it } from 'vitest';

import { warehouseLocationLabel } from './warehouseLocations.js';

describe('warehouseLocationLabel', () => {
  it('подписывает известные места хранения', () => {
    expect(warehouseLocationLabel('repair_fund')).toBe('Ремонтный фонд');
    expect(warehouseLocationLabel('scrap')).toBe('Утиль');
    expect(warehouseLocationLabel('default')).toBe('Основной склад');
  });

  it('цех подписывает по имени, а без имени — по номеру', () => {
    expect(warehouseLocationLabel('workshop_3', 'Механосборочный')).toBe('Цех Механосборочный');
    expect(warehouseLocationLabel('workshop_3')).toBe('Цех 3');
  });

  it('незнакомое место хранения отдаётся как есть — подпись здесь ключ группировки', () => {
    // Общая подпись отсутствия схлопнула бы разные склады в одну строку подытогов
    // оборотной ведомости и в один заголовок на экране локаций.
    expect(warehouseLocationLabel('какой_то_новый_код')).toBe('какой_то_новый_код');
  });

  it('пустое значение даёт прочерк', () => {
    expect(warehouseLocationLabel('')).toBe('—');
    expect(warehouseLocationLabel(null)).toBe('—');
    expect(warehouseLocationLabel(undefined)).toBe('—');
  });
});
