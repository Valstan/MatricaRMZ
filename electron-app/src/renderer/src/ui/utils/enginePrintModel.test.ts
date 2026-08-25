import { describe, expect, it } from 'vitest';

import type { EngineTimelineItem } from '@matricarmz/shared';

import { buildEngineReclamationPrintModel, type EngineReclamationPrintDeps } from './enginePrintModel.js';

function timelineItem(over: Partial<EngineTimelineItem> = {}): EngineTimelineItem {
  return {
    id: 'op-1',
    operationType: 'engine_accept',
    at: 1_750_000_000_000,
    phase: 'acceptance',
    icon: '📥',
    label: 'Приёмка',
    statusLabel: '',
    note: null,
    performedBy: null,
    ...over,
  } as EngineTimelineItem;
}

function deps(over: Partial<EngineReclamationPrintDeps> = {}): EngineReclamationPrintDeps {
  return {
    engineLabel: 'Д-245',
    mainRows: [
      ['Номер двигателя', 'Д-245'],
      ['Марка двигателя', 'ЯМЗ-238'],
    ],
    timeline: [timelineItem()],
    reclamation: {
      acceptedDate: '12.08.2026',
      defectDescription: 'Стук в верхней части',
      actualDefect: 'Задир шейки вала',
      defectNature: 'Производственный',
      actNumber: '14/26',
      actDate: '20.08.2026',
      shippedDate: '25.08.2026',
      comment: 'Отремонтирован по гарантии',
    },
    formatDateTime: (ms: number) => `время:${ms}`,
    ...over,
  };
}

describe('buildEngineReclamationPrintModel', () => {
  it('builds exactly the three agreed sections, in the agreed order', () => {
    const model = buildEngineReclamationPrintModel(deps());
    expect(model.sections.map((s) => s.id)).toEqual(['main', 'history', 'reclamation']);
    expect(model.sections.map((s) => s.title)).toEqual(['Основное', 'История ремонта', 'Рекламация']);
  });

  it('names the engine in the title', () => {
    const model = buildEngineReclamationPrintModel(deps());
    expect(model.title).toContain('Д-245');
  });

  it('prints the main rows it was given', () => {
    const html = buildEngineReclamationPrintModel(deps()).sections[0]?.html ?? '';
    expect(html).toContain('Марка двигателя');
    expect(html).toContain('ЯМЗ-238');
  });

  it('prints every reclamation field under the label the operator sees', () => {
    const html = buildEngineReclamationPrintModel(deps()).sections[2]?.html ?? '';
    for (const label of [
      'Дата приёмки по рекламации',
      'Описание дефекта изделия',
      'Фактически установленный дефект',
      'Установленный характер дефекта',
      'Номер акта исследования',
      'Дата акта исследования',
      'Дата отправки заказчику',
      'Комментарий',
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Задир шейки вала');
    expect(html).toContain('Производственный');
    expect(html).toContain('14/26');
  });

  it('prints a dash instead of leaving an empty cell', () => {
    const model = buildEngineReclamationPrintModel(
      deps({ reclamation: { ...deps().reclamation, actNumber: '', comment: '' } }),
    );
    expect(model.sections[2]?.html).toContain('—');
  });

  it('escapes text the operator pasted from someone else document', () => {
    const model = buildEngineReclamationPrintModel(
      deps({ reclamation: { ...deps().reclamation, actualDefect: '<b>износ</b> & трещина' } }),
    );
    const html = model.sections[2]?.html ?? '';
    expect(html).toContain('&lt;b&gt;износ&lt;/b&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<b>износ</b>');
  });

  it('keeps line breaks of a multi-line field visible on paper', () => {
    const model = buildEngineReclamationPrintModel(
      deps({ reclamation: { ...deps().reclamation, defectDescription: 'Первая строка\nВторая строка' } }),
    );
    const html = model.sections[2]?.html ?? '';
    expect(html).toContain('<br');
    expect(html).toContain('Первая строка');
    expect(html).toContain('Вторая строка');
  });

  it('prints the repair history as a table with the event and its time', () => {
    const model = buildEngineReclamationPrintModel(
      deps({ timeline: [timelineItem({ label: 'Дефектовка', note: 'снят поддон', at: 42 })] }),
    );
    const html = model.sections[1]?.html ?? '';
    expect(html).toContain('Дефектовка');
    expect(html).toContain('снят поддон');
    expect(html).toContain('время:42');
  });

  it('escapes the history note as well', () => {
    const model = buildEngineReclamationPrintModel(
      deps({ timeline: [timelineItem({ note: '<script>alert(1)</script>' })] }),
    );
    expect(model.sections[1]?.html).not.toContain('<script>');
  });

  it('keeps the history section present but honest when there are no events', () => {
    const model = buildEngineReclamationPrintModel(deps({ timeline: [] }));
    const history = model.sections[1];
    expect(history?.id).toBe('history');
    expect(history?.html).toMatch(/нет|Нет/);
  });

  it('shows who did it when the timeline knows', () => {
    const model = buildEngineReclamationPrintModel(
      deps({ timeline: [timelineItem({ performedBy: 'oper' })] }),
    );
    expect(model.sections[1]?.html).toContain('oper');
  });

  it('does not print the service phase code — the operator never sees codes', () => {
    const model = buildEngineReclamationPrintModel(
      deps({ timeline: [timelineItem({ phase: 'acceptance', label: 'Приёмка' })] }),
    );
    expect(model.sections[1]?.html).not.toContain('acceptance');
  });
});
