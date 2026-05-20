import React from 'react';

import {
  WORK_ORDER_KIND_DESCRIPTIONS,
  WORK_ORDER_KIND_LABELS,
  WORK_ORDER_KIND_ORDER,
  WorkOrderKind,
} from '@matricarmz/shared';

import { Button } from './Button.js';

type Choice = WorkOrderKind;

const KIND_ICON: Record<WorkOrderKind, string> = {
  [WorkOrderKind.Regular]: '📝',
  [WorkOrderKind.Repair]: '🔧',
  [WorkOrderKind.Assembly]: '⚙️',
  [WorkOrderKind.Manufacturing]: '🏭',
};

const KIND_ACCENT: Record<WorkOrderKind, string> = {
  [WorkOrderKind.Regular]: '#64748b',
  [WorkOrderKind.Repair]: '#0f766e',
  [WorkOrderKind.Assembly]: '#0369a1',
  [WorkOrderKind.Manufacturing]: '#b45309',
};

export function WorkOrderKindPickerDialog(props: {
  open: boolean;
  onClose: () => void;
  onPick: (kind: Choice) => void;
}) {
  if (!props.open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          padding: 20,
          borderRadius: 10,
          maxWidth: 'min(96vw, 760px)',
          width: '96vw',
          maxHeight: '88vh',
          overflow: 'auto',
          border: '1px solid var(--border)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>Создание наряда — выберите тип</h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>Тип определит складские движения при закрытии наряда</span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 12,
            marginBottom: 12,
          }}
        >
          {WORK_ORDER_KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => props.onPick(kind)}
              style={{
                textAlign: 'left',
                padding: 14,
                borderRadius: 8,
                border: `1px solid var(--border)`,
                background: 'var(--surface)',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                borderLeft: `4px solid ${KIND_ACCENT[kind]}`,
                transition: 'background 120ms ease, border-color 120ms ease, transform 80ms ease',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-hover, #f8fafc)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--surface)';
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 24, lineHeight: 1 }} aria-hidden>
                  {KIND_ICON[kind]}
                </span>
                <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>
                  {WORK_ORDER_KIND_LABELS[kind]}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--subtle)', lineHeight: 1.4 }}>
                {WORK_ORDER_KIND_DESCRIPTIONS[kind]}
              </div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
        </div>
      </div>
    </div>
  );
}
