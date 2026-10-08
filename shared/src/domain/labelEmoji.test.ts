import { describe, expect, it } from 'vitest';

import { labelEmoji } from './labelEmoji.js';

describe('эмодзи подписей (владелец 01.10.2026)', () => {
  it('знаковые подписи маппятся по смыслу', () => {
    expect(labelEmoji('История ремонта')).toBe('🛠️');
    expect(labelEmoji('Акт разборки/дефектовки')).toBe('🔍');
    expect(labelEmoji('Номер двигателя')).toBe('🔢');
    expect(labelEmoji('Цех')).toBe('🏭');
    expect(labelEmoji('Договор')).toBe('📄');
    expect(labelEmoji('Дата прихода')).toBe('📥');
    expect(labelEmoji('Номер накладной (приход)')).toBe('🧾');
    expect(labelEmoji('Дата отгрузки')).toBe('📤');
    expect(labelEmoji('Дата операции')).toBe('📅');
  });

  it('регистр и пробелы не важны', () => {
    expect(labelEmoji('  ЦЕХ ')).toBe('🏭');
  });

  it('неизвестная подпись — пусто, а не чужой значок', () => {
    expect(labelEmoji('Какая-то новая колонка')).toBe('');
    expect(labelEmoji('')).toBe('');
  });
});
