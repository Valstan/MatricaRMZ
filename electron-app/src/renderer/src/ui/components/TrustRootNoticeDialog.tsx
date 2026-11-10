import React from 'react';

import { Button } from './Button.js';
import { TrustRootPanel } from './TrustRootPanel.js';
import { useTrustRoot } from '../hooks/useTrustRoot.js';

/**
 * Подсказка про доверие и подпись, которая всплывает при запуске программы (ADR-0003).
 *
 * Показывается только когда корень НЕ лежит в машинном хранилище — то есть когда Касперский
 * по подписи ещё не доверяет программе. Показывать её каждый запуск нельзя: она превратилась
 * бы в шум, и её перестали бы читать. Поэтому решение «показать или нет» живёт в домене
 * (`trustRootNoticeDecision`): там же и пауза в неделю между показами.
 *
 * Внутри — та же панель, что и в окне обслуживания: один текст на оба места.
 */
export function TrustRootNoticeDialog(props: {
  open: boolean;
  onClose: () => void;
  notify?: (text: string, tone?: 'info' | 'error') => void;
}) {
  const trust = useTrustRoot({ notify: props.notify });

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
        data-trust-root-notice
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          maxWidth: 620,
          width: '100%',
          display: 'grid',
          gap: 12,
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <TrustRootPanel
          status={trust.status}
          busy={trust.busy}
          onInstallUser={() => void trust.installUser()}
          onInstallMachine={() => void trust.installMachine()}
          onRefresh={() => void trust.refresh(true)}
          adminOpenByDefault
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={props.onClose}>
            Позже
          </Button>
        </div>
      </div>
    </div>
  );
}
