// Асинхронный AI-чат: очередь вопросов (≤5/час), ответы пишет облачная рутина
// (Пн–Пт 8:00–17:00 МСК, раз в час). Вопрос можно редактировать/удалять, пока он
// не обработан. Файлы — через существующий files-контур (Яндекс.Диск).
import React, { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from 'react';

import type { AiAgentContext, AiAgentEvent, AiChatRequestItem, FileRef } from '@matricarmz/shared';
import {
  AI_CHAT_MAX_QUESTIONS_PER_HOUR,
  AI_CHAT_STATUS_LABELS,
  getNextAiRunAt,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { theme } from '../theme.js';
import { formatMoscowTime } from '../utils/dateUtils.js';
import { renderMarkdown } from '../utils/markdownLite.js';

const MIN_WIDTH = 360;
const MAX_WIDTH = 800;
const DEFAULT_WIDTH = 520;
const REFRESH_MS = 60_000;

function parseFileRef(json: string | null): FileRef | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' && v.id ? (v as FileRef) : null;
  } catch {
    return null;
  }
}

function parseFileRefs(json: string | null): FileRef[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object' && x.id) as FileRef[]) : [];
  } catch {
    return [];
  }
}

function FileChip(props: { file: FileRef }) {
  return (
    <button
      onClick={() => void window.matrica.files.open({ fileId: props.file.id })}
      title={`Открыть «${props.file.name}» (${Math.round(props.file.size / 1024)} КБ)`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${theme.colors.border}`,
        background: 'transparent',
        color: theme.colors.text,
        fontSize: 12,
        cursor: 'pointer',
        maxWidth: 260,
      }}
    >
      📎
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.file.name}</span>
    </button>
  );
}

export type AiAgentChatHandle = {
  refresh: () => void;
};

export const AiAgentChat = forwardRef<AiAgentChatHandle, {
  visible: boolean;
  context: AiAgentContext;
  lastEvent: AiAgentEvent | null;
  recentEvents?: AiAgentEvent[];
  onClose: () => void;
}>((props, ref) => {
  const [items, setItems] = useState<AiChatRequestItem[]>([]);
  const [text, setText] = useState('');
  const [attach, setAttach] = useState<{ path: string; name: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [verdictDrafts, setVerdictDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const [me, setMe] = useState<{ id: string; role: string } | null>(null);
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [fullscreen, setFullscreen] = useState(false);
  const [now, setNow] = useState<number>(Date.now());

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resizingRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const refresh = useCallback(async () => {
    const res = await window.matrica.aiChat.list();
    if (res.ok) setItems(res.items);
    const meta = await window.matrica.aiChat.meta();
    if (meta.ok) setLastRunAt(meta.lastRunAt);
  }, []);

  useEffect(() => {
    if (!props.visible) return;
    void refresh();
    void window.matrica.auth.status().then((s: any) => {
      const u = s?.user;
      if (u?.id) setMe({ id: String(u.id), role: String(u.role ?? '') });
    });
    const t = setInterval(() => {
      void refresh();
      setNow(Date.now());
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [props.visible, refresh]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [items.length]);

  useImperativeHandle(ref, () => ({ refresh: () => void refresh() }), [refresh]);

  const isSuperadmin = (me?.role ?? '').toLowerCase() === 'superadmin';
  const myItems = useMemo(() => (me ? items.filter((i) => i.userId === me.id) : items), [items, me]);
  const foreignEscalated = useMemo(
    () => (isSuperadmin && me ? items.filter((i) => i.userId !== me.id && i.status === 'escalated') : []),
    [items, me, isSuperadmin],
  );
  const usedThisHour = useMemo(
    () => myItems.filter((i) => i.createdAt > now - 60 * 60 * 1000).length,
    [myItems, now],
  );
  const leftThisHour = Math.max(0, AI_CHAT_MAX_QUESTIONS_PER_HOUR - usedThisHour);
  const nextRunAt = getNextAiRunAt(now);

  async function send() {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.matrica.aiChat.create({ questionText: q, ...(attach ? { filePath: attach.path } : {}) });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setText('');
      setAttach(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function pickFile() {
    const r = await window.matrica.files.pick();
    if (r.ok && r.paths[0]) {
      const p = String(r.paths[0]);
      setAttach({ path: p, name: p.split(/[\\/]/).pop() ?? p });
    }
  }

  async function saveEdit() {
    if (!editingId) return;
    const q = editText.trim();
    if (!q) return;
    const res = await window.matrica.aiChat.update({ id: editingId, questionText: q });
    if (!res.ok) setError(res.error);
    setEditingId(null);
    await refresh();
  }

  async function removeQuestion(id: string) {
    if (!window.confirm('Удалить вопрос?')) return;
    const res = await window.matrica.aiChat.delete({ id });
    if (!res.ok) setError(res.error);
    await refresh();
  }

  async function saveVerdict(id: string) {
    const v = (verdictDrafts[id] ?? '').trim();
    if (!v) return;
    const res = await window.matrica.aiChat.setVerdict({ id, verdictText: v });
    if (!res.ok) setError(res.error);
    await refresh();
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
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, r.startWidth + delta)));
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

  function renderCard(item: AiChatRequestItem, foreign: boolean) {
    const questionFile = parseFileRef(item.questionFileJson);
    const answerFiles = parseFileRefs(item.answerFilesJson);
    const editable = !foreign && item.status === 'pending';
    const isEditing = editingId === item.id;
    return (
      <div
        key={item.id}
        style={{
          marginBottom: 12,
          border: `1px solid ${theme.colors.border}`,
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '8px 10px', background: theme.colors.chatMineBg }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: theme.colors.muted }}>
              {foreign ? `Вопрос от ${item.username} · ` : ''}
              {formatMoscowTime(item.createdAt)}
            </span>
            <span style={{ fontSize: 11, fontWeight: 600 }}>{AI_CHAT_STATUS_LABELS[item.status]}</span>
            {editable && !isEditing && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  onClick={() => {
                    setEditingId(item.id);
                    setEditText(item.questionText);
                  }}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: theme.colors.muted }}
                  title="Редактировать вопрос (пока не обработан)"
                >
                  ✎
                </button>
                <button
                  onClick={() => void removeQuestion(item.id)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 12, color: theme.colors.muted }}
                  title="Удалить вопрос"
                >
                  🗑
                </button>
              </span>
            )}
          </div>
          {isEditing ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                rows={3}
                style={{
                  width: '100%',
                  padding: '6px 8px',
                  border: '1px solid var(--input-border)',
                  background: 'var(--input-bg)',
                  color: theme.colors.text,
                  fontSize: 13,
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <Button onClick={() => void saveEdit()} disabled={!editText.trim()}>
                  Сохранить
                </Button>
                <Button variant="ghost" onClick={() => setEditingId(null)}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.questionText}</div>
          )}
          {questionFile && (
            <div style={{ marginTop: 6 }}>
              <FileChip file={questionFile} />
            </div>
          )}
        </div>

        {item.status === 'answered' && item.answerText != null && (
          <div style={{ padding: '8px 10px', background: theme.colors.chatOtherBg }}>
            <div style={{ fontSize: 11, color: theme.colors.muted, marginBottom: 4 }}>
              🤖 Ответ ИИ · {item.answeredAt ? formatMoscowTime(item.answeredAt) : ''}
            </div>
            <div
              style={{ fontSize: 13, lineHeight: 1.45 }}
              // renderMarkdown escapeHtml-ит вход перед разметкой (markdownLite) — XSS-safe; тот же паттерн, что и прежний AI-чат — nosemgrep
              dangerouslySetInnerHTML={{ __html: renderMarkdown(item.answerText) }}
            />
            {answerFiles.length > 0 && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {answerFiles.map((f) => (
                  <FileChip key={f.id} file={f} />
                ))}
              </div>
            )}
          </div>
        )}

        {item.status === 'escalated' && (
          <div style={{ padding: '8px 10px', background: theme.colors.chatOtherBg }}>
            <div style={{ fontSize: 12, color: theme.colors.muted }}>
              Вопрос передан на рассмотрение администратору.
              {item.escalationNote ? ` Причина: ${item.escalationNote}` : ''}
            </div>
            {item.verdictText && (
              <div style={{ fontSize: 12, marginTop: 4 }}>Решение принято, ответ будет в следующий запуск ИИ.</div>
            )}
            {isSuperadmin && !item.verdictText && (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <textarea
                  value={verdictDrafts[item.id] ?? ''}
                  onChange={(e) => setVerdictDrafts((d) => ({ ...d, [item.id]: e.target.value }))}
                  placeholder="Вердикт для ИИ: как отвечать на такие вопросы…"
                  rows={2}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    border: '1px solid var(--input-border)',
                    background: 'var(--input-bg)',
                    color: theme.colors.text,
                    fontSize: 12,
                    resize: 'vertical',
                  }}
                />
                <div>
                  <Button onClick={() => void saveVerdict(item.id)} disabled={!(verdictDrafts[item.id] ?? '').trim()}>
                    Отправить вердикт
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {item.status === 'rejected' && (
          <div style={{ padding: '8px 10px', background: theme.colors.chatOtherBg }}>
            <div style={{ fontSize: 12, color: theme.colors.muted }}>
              ИИ не может ответить на этот вопрос.
              {item.answerText ? ` ${item.answerText}` : ''}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-ai-agent-ignore="true" data-input-assist="off" style={containerStyle}>
      {!fullscreen && (
        <div
          onMouseDown={onResizeMouseDown}
          style={{ position: 'absolute', top: 0, left: -4, width: 8, height: '100%', cursor: 'ew-resize', zIndex: 21 }}
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
        <div style={{ fontWeight: 900, flex: 1 }}>ИИ‑помощник</div>
        <Button variant="ghost" onClick={() => void refresh()} title="Обновить">
          ⟳
        </Button>
        <Button variant="ghost" onClick={() => setFullscreen((v) => !v)} title={fullscreen ? 'Свернуть' : 'На весь экран'}>
          {fullscreen ? '⤓' : '⤢'}
        </Button>
        <Button variant="ghost" onClick={props.onClose} title="Закрыть">
          ✕
        </Button>
      </div>

      <div
        style={{
          padding: '6px 10px',
          borderBottom: `1px solid ${theme.colors.border}`,
          fontSize: 12,
          color: theme.colors.muted,
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span title="ИИ отвечает раз в час, Пн–Пт с 8:00 до 17:00 МСК">
          Следующий ответ ИИ: <b>{formatMoscowTime(nextRunAt)}</b>
        </span>
        {lastRunAt != null && <span>Последний запуск: {formatMoscowTime(lastRunAt)}</span>}
      </div>

      <div ref={scrollRef} style={{ padding: 10, overflowY: 'auto', flex: '1 1 auto' }}>
        {myItems.length === 0 && foreignEscalated.length === 0 && (
          <div style={{ color: theme.colors.muted, fontSize: 13 }}>
            Задайте вопрос по данным программы — остатки, двигатели, контракты, отчёты. ИИ проанализирует базу данных и
            ответит в ближайший запуск (раз в час в рабочее время).
          </div>
        )}
        {foreignEscalated.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>⚠️ Эскалации (требуют вердикта)</div>
            {foreignEscalated.map((i) => renderCard(i, true))}
          </div>
        )}
        {myItems.map((i) => renderCard(i, false))}
      </div>

      <div style={{ padding: 10, borderTop: `1px solid ${theme.colors.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {error && (
          <div style={{ fontSize: 12, color: theme.colors.danger ?? '#dc2626' }}>
            {error.includes('rate_limit') ? 'Лимит: не больше 5 вопросов в час.' : error}
          </div>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={leftThisHour === 0 ? 'Лимит вопросов на этот час исчерпан…' : 'Введите вопрос…'}
          rows={2}
          disabled={leftThisHour === 0}
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button onClick={() => void send()} disabled={!text.trim() || busy || leftThisHour === 0}>
            Отправить
          </Button>
          <Button variant="ghost" onClick={() => void pickFile()} disabled={busy} title="Прикрепить файл к вопросу">
            📎
          </Button>
          {attach && (
            <span style={{ fontSize: 12, color: theme.colors.muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {attach.name}
              <button
                onClick={() => setAttach(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: theme.colors.muted }}
                title="Убрать файл"
              >
                ✕
              </button>
            </span>
          )}
          <div style={{ flex: 1, fontSize: 11, color: theme.colors.muted, textAlign: 'right' }}>
            Осталось {leftThisHour} из {AI_CHAT_MAX_QUESTIONS_PER_HOUR} вопросов в этот час
          </div>
        </div>
      </div>
    </div>
  );
});
