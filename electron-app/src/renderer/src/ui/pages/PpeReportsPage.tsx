import React from 'react';
import type { ReportPresetId } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { SectionCard } from '../components/SectionCard.js';

const PPE_PRESETS: Array<{ id: ReportPresetId; title: string; hint: string }> = [
  { id: 'ppe_summary_sheet', title: 'Сводная ведомость СИЗ', hint: 'Сотрудник → позиция: норма, выдано, сроки' },
  { id: 'ppe_by_size', title: 'Список СИЗ по размерам', hint: 'Модель → размеры: кому нужно, сколько выдано' },
  { id: 'ppe_unissued', title: 'Справка по невыданному СИЗ', hint: 'Кому и что пора выдавать' },
  { id: 'ppe_stock_list', title: 'Складская ведомость СИЗ', hint: 'Остатки спецодежды по складам' },
  { id: 'ppe_request_sheet', title: 'Заявка на СИЗ', hint: 'Что и сколько закупить на 90 дней: потребность минус остатки' },
  { id: 'ppe_issued', title: 'По выданному СИЗ', hint: 'Каждая выдача за период: кому, что, по какому документу' },
  { id: 'ppe_writeoffs', title: 'Списания СИЗ', hint: 'Списания и сторно: чистое списание за период' },
  { id: 'ppe_operations', title: 'Складские операции СИЗ', hint: 'Все движения по спецодежде: приход, выдача, списание' },
  { id: 'ppe_recipients', title: 'Получившие СИЗ за период', hint: 'Кто получал СИЗ: выдач, позиций, штук' },
  { id: 'ppe_coverage', title: 'Обеспеченность СИЗ', hint: 'Доля сотрудников без просроченных норм' },
  { id: 'ppe_annual_need', title: 'Среднегодовая потребность в СИЗ', hint: 'Потребность в год из норм и сроков носки' },
];

/** Отчёты Кладовщика: одиннадцать пресетов (MVP + фаза 2), открываются штатным экраном шаблона отчёта. */
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
