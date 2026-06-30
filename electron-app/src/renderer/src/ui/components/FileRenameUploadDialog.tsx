import React from 'react';

import { Button } from './Button.js';

export function FileRenameUploadDialog(props: {
  open: boolean;
  stem: string;
  extWithDot: string;
  warning?: string;
  onStemChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  if (!props.open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
        padding: 16,
      }}
    >
      <div style={{ width: 'min(680px, 100%)', borderRadius: 14, background: '#fff', padding: 16, boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Вы можете изменить имя файла на более подходящее название:</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            autoFocus
            value={props.stem}
            onChange={(e) => props.onStemChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') props.onCancel();
              if (e.key === 'Enter') props.onSubmit();
            }}
            placeholder="Имя файла"
            style={{
              flex: 1,
              minWidth: 220,
              border: '1px solid #cbd5e1',
              borderRadius: 10,
              padding: '9px 11px',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <div
            style={{
              minWidth: 100,
              textAlign: 'center',
              border: '1px solid #cbd5e1',
              borderRadius: 10,
              padding: '9px 11px',
              fontSize: 13,
              color: '#334155',
              background: '#f8fafc',
              userSelect: 'none',
            }}
            title="Расширение файла (не редактируется)"
          >
            {props.extWithDot || '(без расширения)'}
          </div>
          <Button onClick={props.onSubmit}>Прикрепить</Button>
          <Button variant="ghost" onClick={props.onCancel}>
            Отмена
          </Button>
        </div>
        {props.warning ? <div style={{ marginTop: 8, fontSize: 12, color: '#b91c1c' }}>{props.warning}</div> : null}
      </div>
    </div>
  );
}

