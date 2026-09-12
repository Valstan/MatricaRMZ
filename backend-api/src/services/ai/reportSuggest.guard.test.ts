import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ИИваныч должен давать ссылку на отчёт С НАСТРОЙКАМИ. Цепочка длинная и рвётся молча:
// инструмент перестанет возвращать готовый маркер, промпт разрешит модели собирать его
// самой (она путает ключи фильтров, и человек этого не увидит), клиент потеряет нагрузку.
// Сторож держит те места, где поломка не видна ни одному другому тесту.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const TOOLS = src('./llmTools.ts');
const ANSWER = src('./aiChatAnswerService.ts');
const SUGGEST = src('./reportSuggestService.ts');

describe('suggest_report отдаёт готовый маркер', () => {
  it('подбор вынесен в сервис, а не считается словами в инструменте', () => {
    expect(TOOLS).toContain('suggestReportsForTask(task)');
    expect(TOOLS, 'прежний наивный скоринг по вхождению слов убран').not.toContain('for (const w of words) if (hay.includes(w)) score += 1;');
  });

  it('сервис собирает и период, и сущности, и маркер', () => {
    expect(SUGGEST).toContain('parseReportTaskPeriod(task, now)');
    expect(SUGGEST).toContain('buildReportTaskFilters(preset');
    expect(SUGGEST).toContain('buildReportLinkMarker(String(preset.id)');
  });

  it('названия ищутся по границам слова — «Д-245» не совпадает с «Д-245М»', () => {
    expect(SUGGEST).toContain('function mentioned(');
    expect(SUGGEST).toContain('!/[a-zа-я0-9]/i.test(before)');
  });

  it('провал поиска по справочникам не ломает подбор', () => {
    expect(SUGGEST).toContain('.catch(() => ({ brands: [], contracts: [], counterparties: [] }))');
  });
});

describe('модели запрещено собирать маркер самой', () => {
  it('подсказка инструмента требует копировать marker как есть', () => {
    const block = TOOLS.slice(TOOLS.indexOf('async function suggestReport'), TOOLS.indexOf('async function getReportUsage'));
    expect(block).toContain('КАК ЕСТЬ');
    expect(block).toContain('Свой маркер не собирай');
  });

  it('системный промпт говорит то же самое', () => {
    expect(ANSWER).toContain('marker КАК ЕСТЬ');
    expect(ANSWER).toContain('Маркер не сочиняй');
  });
});
