import React, { useState, forwardRef, useImperativeHandle } from 'react';

import type { AiAgentAssistResponse, AiAgentContext, AiAgentEvent, AiAgentSuggestion } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { theme } from '../theme.js';

type ChatItem =
  | { id: string; role: 'user'; text: string; ts: number }
  | { id: string; role: 'assistant'; text: string; ts: number; kind: AiAgentSuggestion['kind'] };

function nowMs() {
  return Date.now();
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export type AiAgentChatHandle = {
  appendAssistant: (text: string, kind?: AiAgentSuggestion['kind']) => void;
  appendUser: (text: string) => void;
  setLoading: (loading: boolean) => void;
};

export const AiAgentChat = forwardRef<AiAgentChatHandle, {
  visible: boolean;
  context: AiAgentContext;
  lastEvent: AiAgentEvent | null;
  onClose: () => void;
  onMuteFor: (minutes: number) => void;
  mutedUntil?: number | null;
}>((props, ref) => {
  const [text, setText] = useState('');
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);

  const muted = props.mutedUntil != null && props.mutedUntil > Date.now();
  async function send() {
    const msg = text.trim();
    if (!msg || loading) return;
    setText('');
    const userItem: ChatItem = { id: makeId(), role: 'user', text: msg, ts: nowMs() };
    setItems((prev) => [...prev, userItem]);
    setLoading(true);
    const res = (await window.matrica.aiAgent.assist({
      message: msg,
      context: props.context,
      lastEvent: props.lastEvent,
    })) as AiAgentAssistResponse;
    setLoading(false);
    if (!res || !res.ok) {
      const errText = res && 'error' in res ? String(res.error) : 'Ошибка ИИ‑агента';
      setItems((prev) => [...prev, { id: makeId(), role: 'assistant', text: errText, ts: nowMs(), kind: 'info' }]);
      return;
    }
    const reply = res.reply;
    setItems((prev) => [
      ...prev,
      {
        id: makeId(),
        role: 'assistant',
        text: reply.text,
        ts: nowMs(),
        kind: reply.kind,
      },
    ]);
  }

  useImperativeHandle(
    ref,
    () => ({
      appendAssistant: (textValue, kind = 'info') => {
        if (!textValue) return;
        setItems((prev) => [...prev, { id: makeId(), role: 'assistant', text: textValue, ts: nowMs(), kind }]);
      },
      appendUser: (textValue) => {
        if (!textValue) return;
        setItems((prev) => [...prev, { id: makeId(), role: 'user', text: textValue, ts: nowMs() }]);
      },
      setLoading: (next) => setLoading(next),
    }),
    [],
  );

  if (!props.visible) return null;

  return (
    <div
      data-ai-agent-ignore="true"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        width: 360,
        maxHeight: '70vh',
        borderRadius: 14,
        border: `1px solid ${theme.colors.border}`,
        background: theme.colors.surface,
        boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
      }}
    >
      <div style={{ padding: 10, borderBottom: `1px solid ${theme.colors.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 900, flex: 1 }}>ИИ‑агент</div>
        <Button variant="ghost" onClick={props.onClose}>
          Закрыть
        </Button>
      </div>

      <div style={{ padding: 10, overflowY: 'auto', flex: '1 1 auto' }}>
        {items.length === 0 && (
          <div style={{ color: theme.colors.muted, fontSize: 13 }}>
            Я могу помочь заполнить карточки и справочники. Задайте вопрос или опишите, что нужно.
          </div>
        )}
        {items.map((m) => (
          <div key={m.id} style={{ marginBottom: 8, textAlign: m.role === 'user' ? 'right' : 'left' }}>
            <div
              style={{
                display: 'inline-block',
                padding: '6px 10px',
                borderRadius: 10,
                background: m.role === 'user' ? theme.colors.chatMineBg : theme.colors.chatOtherBg,
                border: `1px solid ${m.role === 'user' ? theme.colors.chatMineBorder : theme.colors.chatOtherBorder}`,
                color: theme.colors.text,
                maxWidth: '90%',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {m.text}
            </div>
            <div style={{ fontSize: 10, color: theme.colors.muted, marginTop: 2 }}>{formatTime(m.ts)}</div>
          </div>
        ))}
        {loading && <div style={{ color: theme.colors.muted, fontSize: 12 }}>ИИ‑агент печатает…</div>}
      </div>

      <div style={{ padding: 10, borderTop: `1px solid ${theme.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Введите вопрос…"
          onKeyDown={(e: any) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={() => void send()} disabled={!text.trim()}>
            ▶
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => props.onMuteFor(10)} title="Отключить ИИ‑агента на 10 минут">
            Отключить на 10
          </Button>
          <Button variant="ghost" onClick={() => props.onMuteFor(20)} title="Отключить ИИ‑агента на 20 минут">
            20
          </Button>
          <Button variant="ghost" onClick={() => props.onMuteFor(30)} title="Отключить ИИ‑агента на 30 минут">
            30
          </Button>
        </div>
      </div>

      {muted && (
        <div style={{ padding: 8, fontSize: 12, color: theme.colors.muted }}>
          ИИ‑агент отключён, но продолжает анализировать действия в фоне.
        </div>
      )}
    </div>
  );
});
