import React from 'react';

import { Button } from './Button.js';
import type { DuplicateCandidate } from '@matricarmz/shared';

type Action = 'cancel' | 'merge' | 'replace' | 'continue';

export function DuplicateWarningDialog(props: {
  open: boolean;
  candidates: DuplicateCandidate[];
  newEntityData: { name?: string; article?: string; price?: number };
  onAction: (action: Action, candidateId?: string) => void;
}) {
  if (!props.open || props.candidates.length === 0) return null;

  const top = props.candidates[0];
  const isExactMatch = top.score >= 950;
  const isHighMatch = top.score >= 700;

  const severityColor = isExactMatch ? '#dc2626' : isHighMatch ? '#b45309' : '#ca8a04';
  const severityIcon = isExactMatch ? '⛔' : isHighMatch ? '⚠️' : 'ℹ️';
  const severityText = isExactMatch
    ? 'Найдено практически идентичное значение'
    : isHighMatch
      ? 'Найдены очень похожие записи'
      : 'Найдены похожие записи';

  function formatScore(score: number): string {
    if (score >= 950) return 'совпадение';
    if (score >= 850) return 'очень похоже';
    if (score >= 700) return 'сильно похоже';
    if (score >= 500) return 'похоже';
    return 'частично похоже';
  }

  function formatPrice(value: unknown): string {
    if (value == null) return '';
    const num = Number(value);
    if (!Number.isFinite(num)) return '';
    return num.toLocaleString('ru-RU');
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onAction('cancel');
      }}
    >
      <div
        style={{
          width: 'min(600px, 100%)',
          maxHeight: '85vh',
          borderRadius: 14,
          background: '#fff',
          boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>{severityIcon}</span>
            <div style={{ fontSize: 17, fontWeight: 700, color: severityColor }}>{severityText}</div>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
            Введённые данные похожи на уже существующую запис
            {props.candidates.length > 1 ? `и (${props.candidates.length} вариант${props.candidates.length < 5 ? 'а' : 'ов'})` : 'ю'}.
            Проверьте, чтобы избежать дублирования.
          </div>
        </div>

        {/* Candidates list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
          {props.candidates.map((c) => (
            <div
              key={c.id}
              style={{
                marginBottom: 12,
                border: c.id === top.id ? `2px solid ${severityColor}` : '1px solid #e5e7eb',
                borderRadius: 10,
                padding: '10px 14px',
                background: c.id === top.id ? `${severityColor}08` : '#fafbfc',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{c.displayName}</div>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: c.score >= 700 ? `${severityColor}18` : '#f3f4f6',
                    color: c.score >= 700 ? severityColor : '#6b7280',
                  }}
                >
                  {formatScore(c.score)}
                </span>
              </div>
              <div style={{ marginTop: 6, display: 'flex', gap: 12, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
                {c.attributes.name && (
                  <span>
                    <strong>Название:</strong> {String(c.attributes.name)}
                  </span>
                )}
                {c.attributes.article && (
                  <span>
                    <strong>Артикул:</strong> {String(c.attributes.article)}
                  </span>
                )}
                {c.attributes.price != null && formatPrice(c.attributes.price) && (
                  <span>
                    <strong>Цена:</strong> {formatPrice(c.attributes.price)}
                  </span>
                )}
              </div>
              {c.id === top.id && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <Button
                    size="sm"
                    onClick={() => props.onAction('merge', c.id)}
                    style={{ fontSize: 12, padding: '5px 12px' }}
                  >
                    Объединить с этой
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => props.onAction('replace', c.id)}
                    style={{ fontSize: 12, padding: '5px 12px' }}
                  >
                    Заменить эту
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* New entity preview */}
        <div style={{ padding: '10px 20px', borderTop: '1px solid #e5e7eb', background: '#f9fafb' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Новая запись:</div>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#6b7280', flexWrap: 'wrap' }}>
            {props.newEntityData.name && <span><strong>Название:</strong> {props.newEntityData.name}</span>}
            {props.newEntityData.article && <span><strong>Артикул:</strong> {props.newEntityData.article}</span>}
            {props.newEntityData.price != null && <span><strong>Цена:</strong> {formatPrice(props.newEntityData.price)}</span>}
          </div>
        </div>

        {/* Footer actions */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => props.onAction('cancel')}>
            Отменить сохранение
          </Button>
          <Button
            variant="ghost"
            onClick={() => props.onAction('continue')}
            style={{ color: '#6b7280' }}
          >
            Всё равно сохранить как новую
          </Button>
        </div>
      </div>
    </div>
  );
}
