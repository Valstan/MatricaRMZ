import { describe, expect, it } from 'vitest';

import {
  AI_SECTION_CONTEXT,
  aiSectionContextSections,
  aiSectionKey,
  aiSectionQuestion,
  aiSectionTitle,
} from './aiSectionContext.js';

// Контекст раздела для нейросети (промт КАРМАНА #176, разрез 4).
//
// Правила, которые держит этот тест:
//  1. У каждого раздела с кнопкой есть СВОЙ текст вопроса — и в нём видно, что это за раздел.
//  2. Карточка (двигатель, наряд, договор) даёт контекст своего раздела, а не «карточки».
//  3. Раздел без записи в реестре всё равно получает внятный вопрос (общий текст по названию).
//  4. Текст вопроса сам говорит, что данные можно дать в любом виде (список, Excel, Word) —
//     это правило промта (#176, п. 7), и оно не должно теряться по дороге.

describe('контекст раздела для нейросети', () => {
  it('у каждого раздела реестра — свой текст с названием раздела', () => {
    for (const key of aiSectionContextSections()) {
      const text = aiSectionQuestion(key);
      expect(text, `раздел ${key}: вопрос пустой`).not.toBe('');
      expect(text, `раздел ${key}: в вопросе нет названия раздела`).toContain(
        aiSectionTitle(key),
      );
    }
  });

  it('вопрос раздела всегда предлагает данные в любом виде', () => {
    for (const key of aiSectionContextSections()) {
      const text = aiSectionQuestion(key);
      expect(text, `раздел ${key}: нет упоминания Excel`).toContain('Excel');
      expect(text, `раздел ${key}: нет упоминания Word`).toContain('Word');
    }
  });

  it('карточка отдаёт контекст своего раздела', () => {
    expect(aiSectionKey('engine')).toBe('engines');
    expect(aiSectionKey('work_order')).toBe('work_orders');
    expect(aiSectionKey('contract')).toBe('contracts');
    expect(aiSectionQuestion('engine')).toBe(aiSectionQuestion('engines'));
    expect(aiSectionQuestion('work_order')).toBe(aiSectionQuestion('work_orders'));
  });

  it('раздел без записи получает общий внятный текст, а не пустоту', () => {
    const text = aiSectionQuestion('reports');
    expect(text).not.toBe('');
    expect(text).toContain('Отчёты');
    expect(text).toContain('Excel');
  });

  it('неизвестный раздел не ломает вопрос', () => {
    const text = aiSectionQuestion('такого_раздела_нет');
    expect(text).not.toBe('');
    expect(text).toContain('Текущий раздел');
  });

  it('производственная программа едет со своим названием', () => {
    const withTitle = aiSectionQuestion('production_program', { programTitle: 'План на ноябрь' });
    const withoutTitle = aiSectionQuestion('production_program', { programTitle: '' });
    expect(withTitle).toContain('План на ноябрь');
    expect(withoutTitle).toContain('Производственная программа');
    expect(withTitle).not.toBe(withoutTitle);
  });

  it('в реестре есть разделы порядка внедрения владельца', () => {
    // Порядок утверждён 27.11.2026: ПП → двигатели → дефектовка → склад → заказы → наряды.
    for (const key of [
      'production_program',
      'engines',
      'work_sheets',
      'stock_balances',
      'stock_documents',
      'nomenclature',
      'contracts',
      'counterparties',
      'requests',
      'work_orders',
    ] as const) {
      expect(AI_SECTION_CONTEXT[key], `раздел ${key} без контекста`).toBeTruthy();
    }
  });
});
