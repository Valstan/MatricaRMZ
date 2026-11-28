import { describe, expect, it } from 'vitest';

import {
  AI_SECTION_CONTEXT,
  aiSectionContextSections,
  aiSectionForPreset,
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

  it('отчёт-пресет знает свой раздел, остальные пресеты — «Отчёты»', () => {
    // Отдельные разделы меню, открывающиеся страницей пресета.
    expect(aiSectionForPreset('engines_now_at_plant')).toBe('now_at_plant');
    expect(aiSectionForPreset('assembly_forecast_7d')).toBe('assembly_forecast');
    // Старые алиасы пресета ведут в тот же раздел (правило — в домене).
    expect(aiSectionForPreset('engine_factory_stages')).toBe('now_at_plant');
    expect(aiSectionForPreset('engines_at_plant')).toBe('now_at_plant');
    // Остальные пресеты открываются из каталога «Отчёты».
    expect(aiSectionForPreset('work_orders')).toBe('reports');
    expect(aiSectionForPreset('такого_пресета_нет')).toBe('reports');
  });

  it('разделы, до которых дошла кнопка, есть в реестре со своим текстом', () => {
    // Разделы, добавленные в разрезе 4 (кнопка во все разделы): реестр обязан знать
    // каждый из них — иначе вопрос был бы общим («Помоги оператору по этому разделу»).
    for (const key of [
      'file_search',
      'engine_rmz_numbers',
      'now_at_plant',
      'assembly_forecast',
      'engine_brands',
      'engine_brand_groups',
      'engine_assembly_bom',
      'repair_norms',
      'services_by_brand',
      'service_price_orders',
      'tool_accounting',
      'warehouse_locations',
      'warehouses_admin',
      'workshops',
      'workshop_stats',
      'masterdata',
      'ppe_norms',
      'ppe_groups',
      'ppe_collective',
      'ppe_import',
      'ppe_stock',
      'ppe_reports',
      'ppe_vacations',
      'children',
      'organization',
      'access_sections',
      'print_forms',
      'print_documents',
      'custom_reports',
      'report_templates',
      'audit',
      'changes',
      'deleted',
      'notes',
      'drafts',
      'settings',
      'user_screens',
      'history',
      'empty_cards',
    ] as const) {
      expect(AI_SECTION_CONTEXT[key], `раздел ${key} без контекста`).toBeTruthy();
    }
  });
});
