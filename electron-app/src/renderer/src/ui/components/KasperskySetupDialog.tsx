import React, { useEffect, useState } from 'react';

import { Button } from './Button.js';

/**
 * Окно инструкции по настройке Касперского.
 *
 * Кому и зачем. На СВЕЖЕЙ машине (установка с нуля, переустановка после того как
 * Касперский удалил программу) список исключений и доверенных программ ещё не
 * настроен — без него антивирус мешает работе. Тогда программа показывает это
 * окно само. При ОБНОВЛЕНИИ окно не всплывает: машина настроена, и лишний
 * показ только шумит — вместо него есть кнопка в окне обслуживания.
 *
 * Права администратора не нужны ни здесь, ни в помощнике: список исключений
 * готовится под конкретный компьютер без повышенных прав, а вносит его в
 * Касперский системный администратор (самозащита Касперского правку настроек
 * извне блокирует — последний шаг всегда за человеком).
 */
export function KasperskySetupDialog(props: {
  open: boolean;
  onClose: () => void;
  /** Что делать, когда администратор закончил: окно закрывается, метка снимается. */
  onDone?: () => void;
  /** Запустить помощника прямо отсюда (он и готовит два файла для импорта). */
  onRunHelper?: () => void;
  notify?: (text: string, tone?: 'info' | 'error') => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setError('');
    void (async () => {
      try {
        const res = await window.matrica.clientOps.adminInstruction();
        if (res.ok) setText(res.text);
        else setError(res.error);
      } catch (e) {
        setError(`Не удалось прочитать инструкцию: ${String(e)}`);
      }
    })();
  }, [props.open]);

  if (!props.open) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1300,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        data-kaspersky-setup-dialog
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 16,
          maxWidth: 720,
          width: '100%',
          display: 'grid',
          gap: 10,
          maxHeight: '92vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18 }}>🛡 Настройка Касперского для «Матрицы РМЗ»</div>

        <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
          Эту настройку один раз делает системный администратор. Дальше программа работает
          без помех — список исключений и доверенных программ закрывает её файлы, а правило
          «не контролировать активность дочерних программ» закрывает всё, что Матрица
          запускает.
        </div>

        {error ? (
          <div style={{ color: 'var(--danger)' }}>{error}</div>
        ) : (
          <div
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 13,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              fontFamily: 'var(--font-mono, monospace)',
              maxHeight: '52vh',
              overflowY: 'auto',
            }}
          >
            {text || 'Читаю инструкцию…'}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {props.onRunHelper ? (
            <Button onClick={props.onRunHelper}>Запустить помощник — он сделает списки</Button>
          ) : null}
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
          <div style={{ flex: 1 }} />
          {props.onDone ? (
            <Button variant="ghost" onClick={props.onDone}>
              Настройка сделана
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
