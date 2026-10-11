import React from 'react';
import type { ReportPresetId } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { SectionCard } from '../components/SectionCard.js';

const PPE_PRESETS: Array<{ id: ReportPresetId; title: string; hint: string }> = [
  { id: 'ppe_summary_sheet', title: 'Сводная ведомость СИЗ', hint: 'Сотрудник → позиция: норма, выдано, сроки' },
  { id: 'ppe_by_size', title: 'Список СИЗ по размерам', hint: 'Модель → размеры: кому нужно, сколько выдано' },
  { id: 'ppe_unissued', title: 'Справка по невыданному СИЗ', hint: 'Кому и что пора выдавать' },
  { id: 'ppe_stock_list', title: 'Складская ведомость СИЗ', hint: 'Остатки спецодежды по складам' },
];

/** Отчёты Кладовщика: четыре пресета MVP, открываются штатным экраном шаблона отчёта. */
export function PpeReportsPage(props: { onOpen: (presetId: ReportPresetId) => void }) {
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <SectionCard title="Отчёты СИЗ">
        <div style={{ display: 'grid', gap: 8 }}>
          {PPE_PRESETS.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Button variant="primary" onClick={() => props.onOpen(p.id)}>
                {p.title}
              </Button>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{p.hint}</span>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
