import React, { useEffect, useRef } from 'react';

import { Button } from './Button.js';

export function FileRenameUploadDialog(props: {
  open: boolean;
  stem: string;
  extWithDot: string;
  warning?: string;
  /**
   * Надпись над полем — объясняет, ОТКУДА взялось предложенное имя.
   *
   * Для скана это важно: имя там предлагает программа по правилу «карточка + скан
   * + время», и оператор должен понимать, что правило можно и нужно поправить.
   * Для обычной загрузки с диска надпись не нужна — там имя и так своё.
   */
  lead?: string;
  /**
   * Выделить предложенное имя целиком.
   *
   * Для скана это обязательное требование оператора: имя предлагается автоматически,
   * но печатать новое надо сразу, не выделяя мышью. Для обычной загрузки с диска
   * имя и так привычно править — там выделение не нужно.
   */
  autoSelect?: boolean;
  onStemChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Хук стоит ДО раннего возврата: иначе React увидит разное число хуков между
  // рендерами (окно то открыто, то закрыто) и уронит дерево.
  useEffect(() => {
    if (!props.open || !props.autoSelect) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [props.open, props.autoSelect]);

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
        {props.lead ? (
          <div style={{ fontSize: 13, color: '#475569', marginBottom: 6 }}>{props.lead}</div>
        ) : null}
        <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>Вы можете изменить имя файла на более подходящее название:</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={inputRef}
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

