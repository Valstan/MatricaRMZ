import { describe, expect, it } from 'vitest';

import { componentTypeLabel } from './componentTypeLabels.js';

describe('componentTypeLabel', () => {
  it('подписывает встроенные типы деталей', () => {
    expect(componentTypeLabel('sleeve')).toBe('Гильза');
    expect(componentTypeLabel('carter')).toBe('Картер');
  });

  // Диалог разборки печатал сюда сырой код: оператор видел «sleeve» в колонке «Тип».
  it('не отдаёт код, которого нет в словаре', () => {
    const text = componentTypeLabel('crankshaft');
    expect(text).toBe('—');
    expect(text).not.toContain('crankshaft');
  });

  it('пустой тип — прочерк, а не пустая ячейка', () => {
    expect(componentTypeLabel('')).toBe('—');
    expect(componentTypeLabel(null)).toBe('—');
    expect(componentTypeLabel(undefined)).toBe('—');
  });
});
