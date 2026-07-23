import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import { Button } from './Button.js';

export type ConfirmOptions = {
  /** Заголовок окна; по умолчанию «Вы уверены?» */
  title?: string;
  /** Что именно будет удалено / выполнено (обязательный по смыслу текст для оператора) */
  detail: string;
  /** Подпись кнопки подтверждения; по умолчанию «ОК». */
  confirmLabel?: string;
  /** Подпись кнопки отмены; по умолчанию «Отмена». */
  cancelLabel?: string;
  /** Тон кнопки подтверждения; по умолчанию «danger» (красная). Для не-разрушительных действий — «neutral»/«success»/«info». */
  confirmTone?: 'danger' | 'neutral' | 'success' | 'info' | 'warn';
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

export type PromptTextOptions = {
  title: string;
  detail?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Подпись второй кнопки, отдающей пустую строку. Без неё пустой ввод запрещён. */
  emptyLabel?: string;
  /** Отказ по введённому значению; непустая строка показывается как ошибка. */
  validate?: (value: string) => string | null;
};

type PromptTextRequest = PromptTextOptions & {
  resolve: (value: string | null) => void;
};

type ConfirmContextValue = {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  pickChoice: (opts: PickChoiceOptions) => Promise<string | null>;
  /** Ввод строки. `null` — оператор отменил; `''` — осознанно выбрал «пусто». */
  promptText: (opts: PromptTextOptions) => Promise<string | null>;
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
  const [promptRequest, setPromptRequest] = useState<PromptTextRequest | null>(null);
  const promptRequestRef = useRef<PromptTextRequest | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);

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

  const closePrompt = useCallback((result: string | null) => {
    const r = promptRequestRef.current;
    promptRequestRef.current = null;
    setPromptRequest(null);
    setPromptValue('');
    setPromptError(null);
    r?.resolve(result);
  }, []);

  /** Submit прогоняет validate: сюда приходит и стоп-кран синтетических артикулов. */
  const submitPrompt = useCallback(() => {
    const r = promptRequestRef.current;
    if (!r) return;
    const trimmed = promptValue.trim();
    if (!trimmed) {
      setPromptError('Введите значение или выберите вариант ниже.');
      return;
    }
    const err = r.validate?.(trimmed) ?? null;
    if (err) {
      setPromptError(err);
      return;
    }
    closePrompt(trimmed);
  }, [closePrompt, promptValue]);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      const next: ConfirmRequest = {
        title: opts.title ?? 'Вы уверены?',
        detail: opts.detail,
        resolve,
        ...(opts.confirmLabel !== undefined ? { confirmLabel: opts.confirmLabel } : {}),
        ...(opts.cancelLabel !== undefined ? { cancelLabel: opts.cancelLabel } : {}),
        ...(opts.confirmTone !== undefined ? { confirmTone: opts.confirmTone } : {}),
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

  const promptText = useCallback((opts: PromptTextOptions) => {
    return new Promise<string | null>((resolve) => {
      const next: PromptTextRequest = {
        title: opts.title,
        resolve,
        ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
        ...(opts.placeholder !== undefined ? { placeholder: opts.placeholder } : {}),
        ...(opts.confirmLabel !== undefined ? { confirmLabel: opts.confirmLabel } : {}),
        ...(opts.emptyLabel !== undefined ? { emptyLabel: opts.emptyLabel } : {}),
        ...(opts.validate !== undefined ? { validate: opts.validate } : {}),
      };
      promptRequestRef.current = next;
      setPromptError(null);
      setPromptValue('');
      setPromptRequest(next);
    });
  }, []);

  const value = useMemo(() => ({ confirm, pickChoice, promptText }), [confirm, pickChoice, promptText]);

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
                {request.cancelLabel ?? 'Отмена'}
              </Button>
              <Button variant="primary" tone={request.confirmTone ?? 'danger'} onClick={() => close(true)}>
                {request.confirmLabel ?? 'ОК'}
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
      {promptRequest ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 4002,
            padding: 16,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closePrompt(null);
          }}
        >
          <div
            role="dialog"
            aria-labelledby="prompt-text-title"
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
            <div id="prompt-text-title" style={{ fontWeight: 800, fontSize: 17, color: '#111827', marginBottom: 10 }}>
              {promptRequest.title}
            </div>
            {promptRequest.detail ? (
              <div style={{ fontSize: 14, color: '#374151', lineHeight: 1.45, marginBottom: 12 }}>
                {promptRequest.detail}
              </div>
            ) : null}
            <input
              autoFocus
              value={promptValue}
              placeholder={promptRequest.placeholder ?? ''}
              onChange={(e) => {
                setPromptValue(e.target.value);
                if (promptError) setPromptError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPrompt();
                if (e.key === 'Escape') closePrompt(null);
              }}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                fontSize: 15,
                borderRadius: 8,
                border: `1px solid ${promptError ? '#dc2626' : '#d1d5db'}`,
              }}
            />
            {promptError ? (
              <div style={{ color: '#dc2626', fontSize: 13, marginTop: 8, lineHeight: 1.4 }}>{promptError}</div>
            ) : null}
            <div style={{ display: 'flex', gap: 10, marginTop: 18, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => closePrompt(null)}>
                Отмена
              </Button>
              {promptRequest.emptyLabel ? (
                <Button variant="ghost" onClick={() => closePrompt('')}>
                  {promptRequest.emptyLabel}
                </Button>
              ) : null}
              <Button variant="primary" tone="info" onClick={submitPrompt}>
                {promptRequest.confirmLabel ?? 'ОК'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}
