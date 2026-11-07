// Инструмент расширения набора: модель сама просит полное меню, когда компактного
// не хватило.
//
// Зачем он нужен: компактный старт пути ответа ускоряет бытовой вопрос, но если
// расширения нет, модель лишена части инструментов — это уже не ускорение, а
// обмен скорости на способность отвечать. Тихая поломка: вопрос уходит в
// эскалацию там, где ответ был рядом.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../database/db.js', () => ({
  db: {},
  pool: { query: vi.fn() },
}));

vi.mock('../../database/schema.js', () => ({
  aiChatMeta: { key: { name: 'key' }, value: { name: 'value' } },
}));

import { ENABLE_FULL_TOOLS, IIVANYCH_TOOLS, runIivanychTool } from './iivanychTools.js';

describe('расширение набора инструментов', () => {
  it('инструмент объявлен в меню Ииваныча и описан', () => {
    expect(IIVANYCH_TOOLS.map((t) => t.name)).toContain('enable_full_tools');
    expect(ENABLE_FULL_TOOLS.name).toBe('enable_full_tools');
    expect(ENABLE_FULL_TOOLS.description.length).toBeGreaterThan(0);
  });

  it('вызов включает расширенный набор и НЕ эскалирует', async () => {
    const side = { escalationReason: null, tables: [], fullToolsEnabled: false };
    const res = await runIivanychTool({ id: 't1', name: 'enable_full_tools', input: {} }, side);

    expect(side.fullToolsEnabled).toBe(true);
    expect(side.escalationReason).toBeNull();
    expect(res?.isError).toBeFalsy();
    expect(res?.content ?? '').toContain('Расширенный набор');
  });

  it('чужой инструмент состояние не трогает', async () => {
    const side = { escalationReason: null, tables: [], fullToolsEnabled: false };
    const res = await runIivanychTool({ id: 't2', name: 'чужой_инструмент', input: {} }, side);

    expect(res).toBeNull();
    expect(side.fullToolsEnabled).toBe(false);
  });
});
