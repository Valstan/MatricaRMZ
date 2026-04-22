import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { Button } from './Button.js';

export type ConfirmOptions = {
  /** Заголовок окна; по умолчанию «Вы уверены?» */
  title?: string;
  /** Что именно будет удалено / выполнено (обязательный по смыслу текст для оператора) */
  detail: string;
};

type ConfirmRequest = ConfirmOptions & {
  resolve: (value: boolean) => void;
};

export type PickChoiceOptions = {
  title: string;
  detail?: string;
  choices: Array<{ id: string; label: string }>;
};

type PickChoiceRequest = PickChoiceOptions & {
  resolve: (value: string | null) => void;
};

type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  pickChoice: (opts: PickChoiceOptions) => Promise<string | null>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function useConfirm(): ConfirmContextValue {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within ConfirmProvider');
  }
  return ctx;
}

/** Для компонентов вне провайдера (тесты); в приложении не используйте. */
export function useConfirmOptional(): ConfirmContextValue | null {
  return useContext(ConfirmContext);
}

export function ConfirmProvider(props: { children: React.ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const requestRef = useRef<ConfirmRequest | null>(null);
  const [choiceRequest, setChoiceRequest] = useState<PickChoiceRequest | null>(null);
  const choiceRequestRef = useRef<PickChoiceRequest | null>(null);

  const close = useCallback((result: boolean) => {
    const r = requestRef.current;
    requestRef.current = null;
    setRequest(null);
    r?.resolve(result);
  }, []);

  const closeChoice = useCallback((result: string | null) => {
    const r = choiceRequestRef.current;
    choiceRequestRef.current = null;
    setChoiceRequest(null);
    r?.resolve(result);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const next: ConfirmRequest = {
        title: opts.title ?? 'Вы уверены?',
        detail: opts.detail,
        resolve,
      };
      requestRef.current = next;
      setRequest(next);
    });
  }, []);

  const pickChoice = useCallback((opts: PickChoiceOptions) => {
    return new Promise<string | null>((resolve) => {
      const next: PickChoiceRequest = {
        title: opts.title,
        choices: opts.choices,
        resolve,
        ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
      };
      choiceRequestRef.current = next;
      setChoiceRequest(next);
    });
  }, []);

  const value = useMemo(() => ({ confirm, pickChoice }), [confirm, pickChoice]);

  return (
    <ConfirmContext.Provider value={value}>
      {props.children}
      {request ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 4000,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close(false);
          }}
        >
          <div
            role="alertdialog"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-detail"
            style={{
              width: 'min(480px, 100%)',
              borderRadius: 12,
              background: '#fff',
              padding: 18,
              boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
              border: '1px solid #e5e7eb',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div id="confirm-dialog-title" style={{ fontWeight: 800, fontSize: 17, color: '#111827', marginBottom: 10 }}>
              {request.title}
            </div>
            <div
              id="confirm-dialog-detail"
              style={{ fontSize: 14, color: '#374151', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}
            >
              {request.detail}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => close(false)}>
                Отмена
              </Button>
              <Button variant="primary" tone="danger" onClick={() => close(true)}>
                ОК
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {choiceRequest ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 4001,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeChoice(null);
          }}
        >
          <div
            role="dialog"
            aria-labelledby="pick-choice-title"
            aria-describedby={choiceRequest.detail ? 'pick-choice-detail' : undefined}
            style={{
              width: 'min(520px, 100%)',
              borderRadius: 12,
              background: '#fff',
              padding: 18,
              boxShadow: '0 24px 64px rgba(2, 6, 23, 0.35)',
              border: '1px solid #e5e7eb',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div id="pick-choice-title" style={{ fontWeight: 800, fontSize: 17, color: '#111827', marginBottom: 10 }}>
              {choiceRequest.title}
            </div>
            {choiceRequest.detail ? (
              <div id="pick-choice-detail" style={{ fontSize: 14, color: '#374151', lineHeight: 1.45, marginBottom: 14 }}>
                {choiceRequest.detail}
              </div>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {choiceRequest.choices.map((c) => (
                <Button key={c.id} variant="primary" onClick={() => closeChoice(c.id)}>
                  {c.label}
                </Button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <Button variant="ghost" onClick={() => closeChoice(null)}>
                Отмена
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}
