import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { ChatDeepLinkPayload } from '@matricarmz/shared';

import { Button } from './Button.js';
import { theme } from '../theme.js';

/**
 * «Правка программы» — окно, из которого работник пишет разработчику прямо с того
 * экрана, где что-то не так. Раздел подставляется сам (тот же контекст, что у
 * ссылки в чат), поэтому от человека требуется только тип и текст.
 *
 * Отправка — обычное личное сообщение суперадмину; отдельной сущности и таблицы
 * не заводим: адресат один, ответ идёт тем же чатом, и правка сразу лежит там,
 * где ведётся переписка.
 */

export type ProgramFeedbackKind = 'remark' | 'question' | 'fix' | 'add';

export const PROGRAM_FEEDBACK_KINDS: Array<{ id: ProgramFeedbackKind; label: string; hint: string }> = [
  { id: 'remark', label: 'Замечание', hint: 'что-то работает не так, как ожидалось' },
  { id: 'question', label: 'Вопрос', hint: 'непонятно, как этим пользоваться' },
  { id: 'fix', label: 'Поправить', hint: 'работает, но неудобно — просьба доработать' },
  { id: 'add', label: 'Добавить', hint: 'не хватает возможности' },
];

export function programFeedbackKindLabel(kind: ProgramFeedbackKind): string {
  return PROGRAM_FEEDBACK_KINDS.find((k) => k.id === kind)?.label ?? 'Правка';
}

/** Текст сообщения: тип, раздел и сама правка — чтобы адресат всё понял без расспросов. */
export function buildProgramFeedbackMessage(args: {
  kind: ProgramFeedbackKind;
  sectionPath: string;
  text: string;
}): string {
  const lines = [`✏️ Правка программы · ${programFeedbackKindLabel(args.kind)}`];
  lines.push(`Раздел: ${args.sectionPath.trim() || 'не определён'}`);
  lines.push('');
  lines.push(args.text.trim());
  return lines.join('\n');
}

export function ProgramFeedbackDialog(props: {
  open: boolean;
  sectionPath: string;
  appLink: ChatDeepLinkPayload;
  /** Отправка: возвращает текст ошибки или null при успехе. */
  onSubmit: (args: { kind: ProgramFeedbackKind; text: string; message: string }) => Promise<string | null>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<ProgramFeedbackKind>('remark');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setKind('remark');
    setText('');
    setError('');
    setDone(false);
    setBusy(false);
    const id = setTimeout(() => textRef.current?.focus(), 30);
    return () => clearTimeout(id);
  }, [props.open]);

  const message = useMemo(
    () => buildProgramFeedbackMessage({ kind, sectionPath: props.sectionPath, text }),
    [kind, props.sectionPath, text],
  );

  if (!props.open) return null;

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    const err = await props.onSubmit({ kind, text: text.trim(), message });
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    setDone(true);
    setTimeout(() => props.onClose(), 1200);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      data-program-feedback-dialog
      onClick={() => !busy && props.onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '92vw',
          background: theme.colors.surface,
          border: `1px solid ${theme.colors.border}`,
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 900, fontSize: 15, color: theme.colors.text }}>Правка программы</div>
        <div style={{ fontSize: 12, color: theme.colors.muted }}>
          Раздел определяется сам: <b style={{ color: theme.colors.text }}>{props.sectionPath || 'не определён'}</b>. Сообщение уйдёт
          разработчику в личный чат — ответ придёт туда же.
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PROGRAM_FEEDBACK_KINDS.map((k) => (
            <Button
              key={k.id}
              variant={kind === k.id ? 'primary' : 'ghost'}
              data-feedback-kind={k.id}
              onClick={() => setKind(k.id)}
              title={k.hint}
            >
              {k.label}
            </Button>
          ))}
        </div>

        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy || done}
          data-feedback-text
          placeholder={PROGRAM_FEEDBACK_KINDS.find((k) => k.id === kind)?.hint ?? 'Опишите, что нужно поправить'}
          rows={7}
          style={{
            width: '100%',
            resize: 'vertical',
            padding: 10,
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 8,
            background: theme.colors.surface,
            color: theme.colors.text,
            fontSize: 13,
            lineHeight: 1.45,
            fontFamily: 'inherit',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        {error ? <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div> : null}
        {done ? <div style={{ color: 'var(--success)', fontSize: 12, fontWeight: 700 }}>Отправлено — спасибо!</div> : null}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button variant="primary" onClick={() => void submit()} disabled={!text.trim() || busy || done}>
            {busy ? 'Отправляю…' : 'Отправить'}
          </Button>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Отмена
          </Button>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: theme.colors.muted }}>Ctrl+Enter — отправить</span>
        </div>
      </div>
    </div>
  );
}
