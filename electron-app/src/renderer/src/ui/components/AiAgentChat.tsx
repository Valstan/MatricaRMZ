import React, { useEffect, useRef, useState, forwardRef, useImperativeHandle, useCallback } from 'react';

import type {
  AiAgentAssistResponse,
  AiAgentContext,
  AiAgentEvent,
  AiAgentStreamEvent,
  AiAgentSuggestion,
  AiChatConversationSummary,
  AiChatHistoryMessage,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { theme } from '../theme.js';
import { formatMoscowTime } from '../utils/dateUtils.js';
import { renderMarkdown } from '../utils/markdownLite.js';

type ChatItem =
  | { id: string; role: 'user'; text: string; ts: number }
  | {
      id: string;
      role: 'assistant';
      text: string;
      ts: number;
      kind: AiAgentSuggestion['kind'];
      actions?: string[];
      model?: string | null;
      streaming?: boolean;
      toolCalls?: string[];
    };

const MIN_WIDTH = 360;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 480;

const QUICK_TEMPLATES: ReadonlyArray<{ title: string; text: string }> = [
  { title: 'Остатки', text: 'Покажи остатки на складе по детали ' },
  { title: 'Заявки', text: 'Покажи последние заявки в снабжение за неделю' },
  { title: 'Прогноз сборки', text: '/sql Покажи прогноз сборки двигателей на 7 дней' },
  { title: 'Карточка двигателя', text: 'Расскажи про двигатель ' },
];

function nowMs() {
  return Date.now();
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(ts: number) {
  return formatMoscowTime(ts);
}

function mapErrorToUserMessage(text: string) {
  const normalized = String(text ?? '').toLowerCase();
  if (
    normalized.includes('timeout') ||
    normalized.includes('time-out') ||
    normalized.includes('тайм') ||
    normalized.includes('http 408') ||
    normalized.includes('http 504')
  ) {
    return 'Я не успеваю ответить, я еще учусь, но скоро начну быстро отвечать на ваши вопросы и помогать вам в работе!';
  }
  return text;
}

function modelBadge(model?: string | null): { label: string; color: string } | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('opus')) return { label: '🟣 Opus', color: '#7c3aed' };
  if (m.includes('sonnet')) return { label: '🟢 Sonnet', color: '#059669' };
  if (m.includes('haiku')) return { label: '🟡 Haiku', color: '#d97706' };
  return { label: model, color: theme.colors.muted };
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
  recentEvents?: AiAgentEvent[];
  onClose: () => void;
}>((props, ref) => {
  const [text, setText] = useState('');
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [fullscreen, setFullscreen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversations, setConversations] = useState<AiChatConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const streamingItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items, loading]);

  const refreshConversations = useCallback(async () => {
    setConversationsLoading(true);
    try {
      const res = await window.matrica.aiAgent.conversationsList({ limit: 50 });
      if (res.ok) setConversations(res.items);
    } finally {
      setConversationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (historyOpen) void refreshConversations();
  }, [historyOpen, refreshConversations]);

  function appendItem(item: ChatItem) {
    setItems((prev) => [...prev, item]);
  }

  function updateAssistantStreaming(deltaOrFinal: { delta?: string; final?: ChatItem }) {
    if (deltaOrFinal.final) {
      setItems((prev) => prev.map((m) => (m.id === streamingItemIdRef.current ? deltaOrFinal.final! : m)));
      return;
    }
    if (deltaOrFinal.delta) {
      const id = streamingItemIdRef.current;
      if (!id) return;
      setItems((prev) =>
        prev.map((m) => (m.id === id && m.role === 'assistant'
          ? { ...m, text: (m.text ?? '') + (deltaOrFinal.delta ?? '') }
          : m)),
      );
    }
  }

  async function sendMessage(messageText: string) {
    const msg = messageText.trim();
    if (!msg || loading) return;
    const userItem: ChatItem = { id: makeId(), role: 'user', text: msg, ts: nowMs() };
    appendItem(userItem);

    const streamingItemId = makeId();
    streamingItemIdRef.current = streamingItemId;
    const placeholder: ChatItem = {
      id: streamingItemId,
      role: 'assistant',
      text: '',
      ts: nowMs(),
      kind: 'info',
      streaming: true,
    };
    appendItem(placeholder);
    setLoading(true);

    const toolCalls: string[] = [];
    let lastModel: string | null = null;
    try {
      const res = (await window.matrica.aiAgent.assistStream(
        {
          message: msg,
          context: props.context,
          lastEvent: props.lastEvent,
          recentEvents: props.recentEvents ?? [],
          ...(conversationId ? { conversationId } : {}),
        },
        (rawEv) => {
          const ev = rawEv as AiAgentStreamEvent;
          if (ev.type === 'start') {
            if (!conversationId) setConversationId(ev.conversationId);
          } else if (ev.type === 'text') {
            updateAssistantStreaming({ delta: ev.delta });
          } else if (ev.type === 'tool_use') {
            toolCalls.push(ev.name);
            setItems((prev) =>
              prev.map((m) =>
                m.id === streamingItemId && m.role === 'assistant'
                  ? { ...m, toolCalls: [...(m.toolCalls ?? []), ev.name] }
                  : m,
              ),
            );
          } else if (ev.type === 'final') {
            lastModel = ev.model;
            const finalItem: ChatItem = {
              id: streamingItemId,
              role: 'assistant',
              text: ev.reply.text,
              ts: nowMs(),
              kind: ev.reply.kind,
              ...(ev.reply.actions && ev.reply.actions.length > 0 ? { actions: ev.reply.actions } : {}),
              model: lastModel,
              ...(toolCalls.length > 0 ? { toolCalls } : {}),
            };
            updateAssistantStreaming({ final: finalItem });
            if (!conversationId && ev.conversationId) setConversationId(ev.conversationId);
          } else if (ev.type === 'error') {
            updateAssistantStreaming({
              final: {
                id: streamingItemId,
                role: 'assistant',
                text: mapErrorToUserMessage(ev.error),
                ts: nowMs(),
                kind: 'info',
              },
            });
          }
        },
      )) as AiAgentAssistResponse;
      if (res && !res.ok) {
        updateAssistantStreaming({
          final: {
            id: streamingItemId,
            role: 'assistant',
            text: mapErrorToUserMessage(res.error ?? 'Ошибка ИИ‑агента'),
            ts: nowMs(),
            kind: 'info',
          },
        });
      }
    } catch (e) {
      updateAssistantStreaming({
        final: {
          id: streamingItemId,
          role: 'assistant',
          text: mapErrorToUserMessage(String(e)),
          ts: nowMs(),
          kind: 'info',
        },
      });
    } finally {
      streamingItemIdRef.current = null;
      setLoading(false);
    }
  }

  async function send() {
    const msg = text.trim();
    if (!msg) return;
    setText('');
    await sendMessage(msg);
  }

  async function loadConversation(convId: string) {
    setLoading(true);
    try {
      const res = await window.matrica.aiAgent.conversationMessages({ conversationId: convId, limit: 500 });
      if (res.ok) {
        const newItems: ChatItem[] = res.messages
          .filter((m: AiChatHistoryMessage) => m.role === 'user' || m.role === 'assistant')
          .map((m: AiChatHistoryMessage) =>
            m.role === 'user'
              ? { id: m.id, role: 'user' as const, text: m.content, ts: m.ts }
              : {
                  id: m.id,
                  role: 'assistant' as const,
                  text: m.content,
                  ts: m.ts,
                  kind: 'info' as const,
                  ...(m.model ? { model: m.model } : {}),
                },
          );
        setItems(newItems);
        setConversationId(convId);
        setHistoryOpen(false);
      }
    } finally {
      setLoading(false);
    }
  }

  async function deleteConversation(convId: string) {
    const ok = window.confirm('Удалить этот разговор без возможности восстановления?');
    if (!ok) return;
    const res = await window.matrica.aiAgent.conversationDelete({ conversationId: convId });
    if (res.ok) {
      if (conversationId === convId) {
        setConversationId(null);
        setItems([]);
      }
      await refreshConversations();
    }
  }

  function startNewConversation() {
    setConversationId(null);
    setItems([]);
    setHistoryOpen(false);
  }

  function copyMessage(itemId: string, text: string) {
    try {
      navigator.clipboard?.writeText(text);
      setCopiedId(itemId);
      setTimeout(() => setCopiedId((c) => (c === itemId ? null : c)), 1500);
    } catch {
      // ignore clipboard errors silently
    }
  }

  function onResizeMouseDown(e: React.MouseEvent) {
    if (fullscreen) return;
    resizingRef.current = { startX: e.clientX, startWidth: width };
    e.preventDefault();
  }

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      const r = resizingRef.current;
      if (!r) return;
      const delta = r.startX - e.clientX;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, r.startWidth + delta));
      setWidth(next);
    }
    function onMouseUp() {
      resizingRef.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      appendAssistant: (textValue, kind = 'info') => {
        if (!textValue) return;
        appendItem({ id: makeId(), role: 'assistant', text: textValue, ts: nowMs(), kind });
      },
      appendUser: (textValue) => {
        if (!textValue) return;
        appendItem({ id: makeId(), role: 'user', text: textValue, ts: nowMs() });
      },
      setLoading: (next) => setLoading(next),
    }),
    [],
  );

  if (!props.visible) return null;

  const containerStyle: React.CSSProperties = fullscreen
    ? {
        position: 'fixed',
        inset: 16,
        borderRadius: 14,
        border: `1px solid ${theme.colors.border}`,
        background: theme.colors.surface,
        boxShadow: '0 20px 80px rgba(0,0,0,0.35)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 30,
      }
    : {
        position: 'fixed',
        right: 16,
        bottom: 16,
        width,
        maxHeight: '80vh',
        borderRadius: 14,
        border: `1px solid ${theme.colors.border}`,
        background: theme.colors.surface,
        boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
      };

  return (
    <div data-ai-agent-ignore="true" data-input-assist="off" style={containerStyle}>
      {!fullscreen && (
        <div
          onMouseDown={onResizeMouseDown}
          style={{
            position: 'absolute',
            top: 0,
            left: -4,
            width: 8,
            height: '100%',
            cursor: 'ew-resize',
            zIndex: 21,
          }}
        />
      )}
      <div
        style={{
          padding: 10,
          borderBottom: `1px solid ${theme.colors.border}`,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <div style={{ fontWeight: 900, flex: 1 }}>
          ИИ‑агент (Claude){conversationId ? <span style={{ color: theme.colors.muted, fontWeight: 400, marginLeft: 6, fontSize: 11 }}>#{conversationId.slice(0, 8)}</span> : null}
        </div>
        <Button variant="ghost" onClick={startNewConversation} title="Новый разговор">
          ＋
        </Button>
        <Button variant="ghost" onClick={() => setHistoryOpen((v) => !v)} title="История разговоров">
          {historyOpen ? '✕ История' : '☰ История'}
        </Button>
        <Button variant="ghost" onClick={() => setFullscreen((v) => !v)} title={fullscreen ? 'Свернуть' : 'На весь экран'}>
          {fullscreen ? '⤓' : '⤢'}
        </Button>
        <Button variant="ghost" onClick={props.onClose} title="Закрыть">
          ✕
        </Button>
      </div>

      {historyOpen && (
        <div
          style={{
            padding: 8,
            borderBottom: `1px solid ${theme.colors.border}`,
            background: theme.colors.surface2 ?? theme.colors.surface,
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {conversationsLoading && <div style={{ fontSize: 12, color: theme.colors.muted }}>Загрузка…</div>}
          {!conversationsLoading && conversations.length === 0 && (
            <div style={{ fontSize: 12, color: theme.colors.muted }}>Разговоров пока нет.</div>
          )}
          {conversations.map((c) => (
            <div
              key={c.conversationId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 4px',
                borderRadius: 6,
                background: conversationId === c.conversationId ? theme.colors.chatMineBg : 'transparent',
                cursor: 'pointer',
              }}
              onClick={() => void loadConversation(c.conversationId)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={c.lastUserMessage}
                >
                  {c.lastUserMessage || '(пустое сообщение)'}
                </div>
                <div style={{ fontSize: 10, color: theme.colors.muted }}>
                  {formatTime(c.lastMessageAt)} · {c.messageCount} сообщений
                  {c.lastModel ? ` · ${c.lastModel.replace(/^claude-/, '')}` : ''}
                </div>
              </div>
              <Button
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteConversation(c.conversationId);
                }}
                title="Удалить"
              >
                🗑
              </Button>
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} style={{ padding: 10, overflowY: 'auto', flex: '1 1 auto' }}>
        {items.length === 0 && (
          <div style={{ color: theme.colors.muted, fontSize: 13 }}>
            Я могу помочь заполнить карточки, посмотреть остатки и собрать отчёт. Задайте вопрос.
          </div>
        )}
        {items.map((m) => {
          const isUser = m.role === 'user';
          const badge = !isUser && 'model' in m ? modelBadge(m.model) : null;
          return (
            <div key={m.id} style={{ marginBottom: 10, textAlign: isUser ? 'right' : 'left' }}>
              <div
                style={{
                  display: 'inline-block',
                  padding: '6px 10px',
                  borderRadius: 10,
                  background: isUser ? theme.colors.chatMineBg : theme.colors.chatOtherBg,
                  border: `1px solid ${isUser ? theme.colors.chatMineBorder : theme.colors.chatOtherBorder}`,
                  color: theme.colors.text,
                  maxWidth: '90%',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  textAlign: 'left',
                }}
              >
                {isUser ? (
                  m.text
                ) : (
                  <div
                    style={{ fontSize: 14, lineHeight: 1.45 }}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text || (loading ? '…' : '')) }}
                  />
                )}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: theme.colors.muted,
                  marginTop: 2,
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  justifyContent: isUser ? 'flex-end' : 'flex-start',
                }}
              >
                <span>{formatTime(m.ts)}</span>
                {badge && <span style={{ color: badge.color, fontWeight: 600 }}>{badge.label}</span>}
                {!isUser && 'toolCalls' in m && m.toolCalls && m.toolCalls.length > 0 && (
                  <span title={m.toolCalls.join(', ')}>🔧 {m.toolCalls.length}</span>
                )}
                {!isUser && (
                  <button
                    onClick={() => copyMessage(m.id, m.text)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      color: theme.colors.muted,
                      cursor: 'pointer',
                      fontSize: 10,
                    }}
                    title="Скопировать"
                  >
                    {copiedId === m.id ? '✓ скопировано' : '⧉ копировать'}
                  </button>
                )}
              </div>
              {!isUser && 'actions' in m && m.actions && m.actions.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, justifyContent: 'flex-start' }}>
                  {m.actions.map((a, idx) => (
                    <Button key={idx} variant="ghost" onClick={() => void sendMessage(a)} disabled={loading}>
                      {a}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {loading && streamingItemIdRef.current == null && (
          <div style={{ color: theme.colors.muted, fontSize: 12 }}>ИИ‑агент печатает…</div>
        )}
      </div>

      <div style={{ padding: 10, borderTop: `1px solid ${theme.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {QUICK_TEMPLATES.map((tpl) => (
            <Button
              key={tpl.title}
              variant="ghost"
              onClick={() => setText((t) => (t.endsWith(' ') ? t : `${t}${t ? ' ' : ''}`) + tpl.text)}
              disabled={loading}
              title={tpl.text}
            >
              {tpl.title}
            </Button>
          ))}
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Введите вопрос…"
          rows={2}
          style={{
            width: '100%',
            padding: '7px 10px',
            border: '1px solid var(--input-border)',
            outline: 'none',
            background: 'var(--input-bg)',
            color: theme.colors.text,
            fontSize: 14,
            lineHeight: 1.2,
            minHeight: 32,
            boxShadow: 'var(--input-shadow)',
            resize: 'vertical',
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={() => void send()} disabled={!text.trim() || loading}>
            ▶
          </Button>
          <div style={{ flex: 1, fontSize: 11, color: theme.colors.muted, textAlign: 'right' }}>
            Enter — отправить · Shift+Enter — новая строка
          </div>
        </div>
      </div>
    </div>
  );
});
