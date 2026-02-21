import React, { useEffect, useMemo, useState } from 'react';

import type { ChatDeepLinkPayload, ChatMessageItem, NoteItem, NoteShareItem } from '@matricarmz/shared';

import { theme } from '../theme.js';

type RecentVisitEntry = {
  id: string;
  at: number;
  title: string;
  link: ChatDeepLinkPayload;
};

type NoteView = NoteItem & { sourceLink: ChatDeepLinkPayload | null };
type QuickStartTile = {
  id: string;
  icon: string;
  title: string;
  subtitle: string;
  tab: ChatDeepLinkPayload['tab'];
  gradient: string;
};

type QuickTilesPrefs = {
  order: string[];
  hidden: string[];
};

function quickTilesStorageKey(userId: string) {
  return `matrica:history:quick-tiles:${userId}`;
}

function formatDateTime(ms: number) {
  try {
    return new Date(ms).toLocaleString('ru-RU');
  } catch {
    return '';
  }
}

function formatAgo(ms: number) {
  const diffSec = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec} сек назад`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} ч назад`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay} дн назад`;
}

function asAppLink(value: unknown): ChatDeepLinkPayload | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== 'app_link') return null;
  if (typeof candidate.tab !== 'string' || candidate.tab.length === 0) return null;
  return candidate as ChatDeepLinkPayload;
}

function extractNoteSourceLink(note: NoteItem): ChatDeepLinkPayload | null {
  for (const block of note.body ?? []) {
    if (block?.kind !== 'link') continue;
    const appLink = asAppLink((block as any).appLink);
    if (appLink) return appLink;
  }
  return null;
}

function messagePreview(message: ChatMessageItem) {
  if (message.messageType === 'deep_link') {
    const appLink = asAppLink(message.payload);
    const crumbs = Array.isArray(appLink?.breadcrumbs) ? appLink.breadcrumbs.filter(Boolean) : [];
    return crumbs.length > 0 ? crumbs.join(' / ') : 'Переход к разделу';
  }
  if (message.messageType === 'file') return 'Вложенный файл';
  return String(message.bodyText ?? '').trim() || 'Сообщение';
}

export function HistoryPage(props: {
  meUserId: string;
  recentVisits: RecentVisitEntry[];
  onNavigate: (link: ChatDeepLinkPayload) => void;
  onOpenNotes: (noteId?: string | null) => void;
  onOpenChat: () => void;
}) {
  const [appVersion, setAppVersion] = useState<string>('');
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [tilesEditMode, setTilesEditMode] = useState(false);
  const [dragTileId, setDragTileId] = useState<string | null>(null);

  useEffect(() => {
    void window.matrica.app.version().then((v) => setAppVersion(String(v ?? ''))).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [notesRes, chatRes] = await Promise.all([
        window.matrica.notes.list().catch(() => null),
        window.matrica.chat.list({ mode: 'global', limit: 60 }).catch(() => null),
      ]);
      if (!alive) return;

      if (notesRes && (notesRes as any).ok) {
        const allNotes = ((notesRes as any).notes ?? []) as NoteItem[];
        const shares = ((notesRes as any).shares ?? []) as NoteShareItem[];
        const myShares = new Map<string, NoteShareItem>();
        for (const share of shares) {
          if (share.recipientUserId === props.meUserId) myShares.set(String(share.noteId), share);
        }
        const visible = allNotes
          .filter((note) => {
            if (note.ownerUserId === props.meUserId) return true;
            const share = myShares.get(String(note.id));
            if (!share) return false;
            return !share.hidden;
          })
          .map((note) => ({ ...note, sourceLink: extractNoteSourceLink(note) }))
          .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
          .slice(0, 8);
        setNotes(visible);
      }

      if (chatRes && (chatRes as any).ok) {
        const recent = (((chatRes as any).messages ?? []) as ChatMessageItem[])
          .slice()
          .sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
          .slice(0, 10);
        setMessages(recent);
      }
    };
    void load();
    const id = window.setInterval(() => void load(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [props.meUserId]);

  const rightColumnVisits = useMemo(
    () =>
      [...(props.recentVisits ?? [])]
        .sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0))
        .slice(0, 10),
    [props.recentVisits],
  );

  const quickStartTiles: QuickStartTile[] = useMemo(
    () => [
      {
        id: 'engines',
        icon: '⚙️',
        title: 'Двигатели',
        subtitle: 'Список и карточки двигателей',
        tab: 'engines',
        gradient: 'linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)',
      },
      {
        id: 'requests',
        icon: '📦',
        title: 'Заявки',
        subtitle: 'Закупка и потребности',
        tab: 'requests',
        gradient: 'linear-gradient(135deg, #0f766e 0%, #10b981 100%)',
      },
      {
        id: 'parts',
        icon: '🧩',
        title: 'Детали',
        subtitle: 'Справочник деталей и узлов',
        tab: 'parts',
        gradient: 'linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)',
      },
      {
        id: 'notes',
        icon: '📝',
        title: 'Заметки',
        subtitle: 'Личные и общие записи',
        tab: 'notes',
        gradient: 'linear-gradient(135deg, #c2410c 0%, #f97316 100%)',
      },
      {
        id: 'reports',
        icon: '📊',
        title: 'Отчеты',
        subtitle: 'Аналитика и выгрузки',
        tab: 'reports',
        gradient: 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)',
      },
    ],
    [],
  );

  const allTileIds = useMemo(() => quickStartTiles.map((tile) => tile.id), [quickStartTiles]);

  const [quickTileOrder, setQuickTileOrder] = useState<string[]>(allTileIds);
  const [hiddenQuickTiles, setHiddenQuickTiles] = useState<string[]>([]);

  useEffect(() => {
    const userId = String(props.meUserId ?? '').trim();
    if (!userId) {
      setQuickTileOrder(allTileIds);
      setHiddenQuickTiles([]);
      return;
    }
    try {
      const raw = window.localStorage.getItem(quickTilesStorageKey(userId));
      if (!raw) {
        setQuickTileOrder(allTileIds);
        setHiddenQuickTiles([]);
        return;
      }
      const parsed = JSON.parse(raw) as QuickTilesPrefs;
      const nextOrder = Array.isArray(parsed?.order) ? parsed.order.filter((id) => allTileIds.includes(String(id))) : [];
      for (const id of allTileIds) {
        if (!nextOrder.includes(id)) nextOrder.push(id);
      }
      const nextHidden = Array.isArray(parsed?.hidden)
        ? parsed.hidden.filter((id) => allTileIds.includes(String(id)) && nextOrder.includes(String(id)))
        : [];
      setQuickTileOrder(nextOrder);
      setHiddenQuickTiles(Array.from(new Set(nextHidden)));
    } catch {
      setQuickTileOrder(allTileIds);
      setHiddenQuickTiles([]);
    }
  }, [props.meUserId, allTileIds]);

  useEffect(() => {
    const userId = String(props.meUserId ?? '').trim();
    if (!userId) return;
    const payload: QuickTilesPrefs = {
      order: quickTileOrder.filter((id) => allTileIds.includes(id)),
      hidden: hiddenQuickTiles.filter((id) => allTileIds.includes(id)),
    };
    try {
      window.localStorage.setItem(quickTilesStorageKey(userId), JSON.stringify(payload));
    } catch {
      // ignore storage issues
    }
  }, [props.meUserId, allTileIds, quickTileOrder, hiddenQuickTiles]);

  const quickTilesById = useMemo(() => {
    const map = new Map<string, QuickStartTile>();
    for (const tile of quickStartTiles) map.set(tile.id, tile);
    return map;
  }, [quickStartTiles]);

  const visibleQuickTiles = useMemo(
    () => quickTileOrder.map((id) => quickTilesById.get(id)).filter((tile): tile is QuickStartTile => !!tile && !hiddenQuickTiles.includes(tile.id)),
    [quickTileOrder, quickTilesById, hiddenQuickTiles],
  );

  const hiddenQuickTilesList = useMemo(
    () => quickTileOrder.map((id) => quickTilesById.get(id)).filter((tile): tile is QuickStartTile => !!tile && hiddenQuickTiles.includes(tile.id)),
    [quickTileOrder, quickTilesById, hiddenQuickTiles],
  );

  const recentByTab = useMemo(() => {
    const out = new Map<string, number>();
    for (const visit of rightColumnVisits) {
      const key = String(visit.link?.tab ?? '');
      out.set(key, Number(out.get(key) ?? 0) + 1);
    }
    return out;
  }, [rightColumnVisits]);

  function moveTileBefore(fromId: string, toId: string) {
    if (fromId === toId) return;
    setQuickTileOrder((prev) => {
      const list = [...prev];
      const fromIndex = list.indexOf(fromId);
      const toIndex = list.indexOf(toId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const [item] = list.splice(fromIndex, 1);
      if (!item) return prev;
      const insertIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
      list.splice(insertIndex, 0, item);
      return list;
    });
  }

  function resetTilesPrefs() {
    setQuickTileOrder(allTileIds);
    setHiddenQuickTiles([]);
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div
        style={{
          borderRadius: 16,
          padding: '18px 20px',
          border: '1px solid rgba(14, 116, 144, 0.32)',
          background:
            'radial-gradient(circle at 20% 30%, rgba(56, 189, 248, 0.28), transparent 58%), radial-gradient(circle at 78% 15%, rgba(244, 114, 182, 0.24), transparent 56%), linear-gradient(120deg, #0f172a 0%, #1e293b 45%, #1d4ed8 100%)',
          color: '#f8fafc',
        }}
      >
        <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: 0.3 }}>Матрица РМЗ</div>
        <div style={{ marginTop: 4, fontSize: 13, color: 'rgba(226,232,240,0.9)' }}>
          Версия: <b>{appVersion || '—'}</b>
        </div>
        <div style={{ marginTop: 10, maxWidth: 920, lineHeight: 1.45, color: 'rgba(226,232,240,0.96)' }}>
          Информационный стартовый экран: здесь можно быстро вернуться к последним рабочим местам, заметкам и сообщениям из чата.
        </div>
      </div>

      <div
        style={{
          borderRadius: 14,
          border: '1px solid rgba(59, 130, 246, 0.25)',
          background:
            'radial-gradient(circle at 8% 15%, rgba(125, 211, 252, 0.15), transparent 40%), radial-gradient(circle at 92% 80%, rgba(196, 181, 253, 0.18), transparent 42%), #ffffff',
          padding: 12,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 17, color: '#1e3a8a', marginBottom: 8 }}>Быстрый старт</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <div style={{ color: '#475569', flex: '1 1 auto' }}>
            {tilesEditMode ? 'Режим настройки: перетаскивайте плитки, скрывайте и показывайте их.' : 'Открывайте популярные разделы в один клик.'}
          </div>
          <button
            type="button"
            onClick={() => setTilesEditMode((prev) => !prev)}
            style={{
              border: '1px solid rgba(59, 130, 246, 0.35)',
              borderRadius: 999,
              background: tilesEditMode ? '#1d4ed8' : '#eff6ff',
              color: tilesEditMode ? '#ffffff' : '#1e3a8a',
              fontWeight: 700,
              cursor: 'pointer',
              padding: '4px 10px',
            }}
          >
            {tilesEditMode ? 'Готово' : 'Настроить'}
          </button>
          {tilesEditMode && (
            <button
              type="button"
              onClick={resetTilesPrefs}
              style={{
                border: '1px solid rgba(100, 116, 139, 0.3)',
                borderRadius: 999,
                background: '#ffffff',
                color: '#0f172a',
                fontWeight: 600,
                cursor: 'pointer',
                padding: '4px 10px',
              }}
            >
              Сброс
            </button>
          )}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 10,
          }}
        >
          {visibleQuickTiles.map((tile) => {
            const recentCount = Number(recentByTab.get(tile.tab) ?? 0);
            return (
              <button
                key={tile.id}
                type="button"
                draggable={tilesEditMode}
                onDragStart={() => setDragTileId(tile.id)}
                onDragEnd={() => setDragTileId(null)}
                onDragOver={(event) => {
                  if (!tilesEditMode) return;
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!tilesEditMode) return;
                  event.preventDefault();
                  if (dragTileId) moveTileBefore(dragTileId, tile.id);
                }}
                onClick={() => {
                  if (tilesEditMode) return;
                  props.onNavigate({
                    kind: 'app_link',
                    tab: tile.tab,
                    breadcrumbs: [tile.title],
                  });
                }}
                style={{
                  border: '1px solid rgba(148, 163, 184, 0.28)',
                  borderRadius: 12,
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: '#ffffff',
                  padding: '11px 12px',
                  background: tile.gradient,
                  boxShadow: '0 10px 24px rgba(15,23,42,0.18)',
                  minHeight: 86,
                  opacity: dragTileId && dragTileId !== tile.id ? 0.94 : 1,
                  outline: dragTileId === tile.id ? '2px dashed rgba(255,255,255,0.8)' : 'none',
                }}
                title={tile.title}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 22, lineHeight: 1 }}>{tile.icon}</span>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {recentCount > 0 ? (
                      <span
                        style={{
                          fontSize: 11,
                          borderRadius: 999,
                          padding: '2px 7px',
                          background: 'rgba(255,255,255,0.24)',
                          fontWeight: 700,
                        }}
                      >
                        {recentCount} недавн.
                      </span>
                    ) : null}
                    {tilesEditMode && (
                      <span
                        style={{
                          fontSize: 11,
                          borderRadius: 999,
                          padding: '2px 7px',
                          background: 'rgba(15,23,42,0.25)',
                          fontWeight: 700,
                        }}
                      >
                        Перетащить
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ marginTop: 7, fontSize: 15, fontWeight: 800 }}>{tile.title}</div>
                <div style={{ marginTop: 3, fontSize: 12, opacity: 0.95 }}>{tile.subtitle}</div>
                {tilesEditMode && (
                  <div style={{ marginTop: 8 }}>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setHiddenQuickTiles((prev) => Array.from(new Set([...prev, tile.id])));
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setHiddenQuickTiles((prev) => Array.from(new Set([...prev, tile.id])));
                        }
                      }}
                      style={{
                        fontSize: 12,
                        borderRadius: 999,
                        padding: '2px 8px',
                        background: 'rgba(15,23,42,0.25)',
                        cursor: 'pointer',
                      }}
                    >
                      Скрыть
                    </span>
                  </div>
                )}
              </button>
            );
          })}
        </div>
        {tilesEditMode && hiddenQuickTilesList.length > 0 && (
          <div style={{ marginTop: 10, borderTop: '1px dashed rgba(148,163,184,0.45)', paddingTop: 10 }}>
            <div style={{ fontWeight: 700, color: '#334155', marginBottom: 7 }}>Скрытые плитки</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {hiddenQuickTilesList.map((tile) => (
                <button
                  key={`hidden-${tile.id}`}
                  type="button"
                  onClick={() => setHiddenQuickTiles((prev) => prev.filter((id) => id !== tile.id))}
                  style={{
                    border: '1px solid rgba(100, 116, 139, 0.4)',
                    borderRadius: 999,
                    padding: '5px 10px',
                    background: '#ffffff',
                    color: '#0f172a',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {tile.icon} {tile.title} + Показать
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 42%) minmax(420px, 58%)',
          gap: 12,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div style={{ borderRadius: 12, border: `1px solid ${theme.colors.border}`, background: theme.colors.surface2, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Последние заметки</div>
            {notes.length === 0 ? (
              <div style={{ color: theme.colors.muted }}>Пока нет заметок.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {notes.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => {
                      if (note.sourceLink) props.onNavigate(note.sourceLink);
                      else props.onOpenNotes(note.id);
                    }}
                    style={{
                      textAlign: 'left',
                      border: `1px solid ${theme.colors.border}`,
                      borderRadius: 10,
                      background: '#ffffff',
                      padding: '10px 11px',
                      cursor: 'pointer',
                    }}
                    title={note.sourceLink ? 'Открыть источник из заметки' : 'Открыть заметку'}
                  >
                    <div style={{ fontWeight: 700, color: '#0f172a' }}>{String(note.title ?? '').trim() || 'Заметка'}</div>
                    <div style={{ fontSize: 12, color: theme.colors.muted, marginTop: 4 }}>{formatDateTime(Number(note.updatedAt ?? note.createdAt ?? Date.now()))}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ borderRadius: 12, border: `1px solid ${theme.colors.border}`, background: theme.colors.surface2, padding: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Последние сообщения из чата</div>
            {messages.length === 0 ? (
              <div style={{ color: theme.colors.muted }}>В общем чате пока нет сообщений.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {messages.map((message) => {
                  const sourceLink = message.messageType === 'deep_link' ? asAppLink(message.payload) : null;
                  return (
                    <button
                      key={message.id}
                      type="button"
                      onClick={() => {
                        if (sourceLink) props.onNavigate(sourceLink);
                        else props.onOpenChat();
                      }}
                      style={{
                        textAlign: 'left',
                        border: `1px solid ${theme.colors.border}`,
                        borderRadius: 10,
                        background: '#ffffff',
                        padding: '10px 11px',
                        cursor: 'pointer',
                      }}
                      title={sourceLink ? 'Перейти в источник сообщения' : 'Открыть чат'}
                    >
                      <div style={{ fontWeight: 700, color: '#0f172a' }}>{String(message.senderUsername ?? 'Пользователь')}</div>
                      <div style={{ marginTop: 3, color: '#1e293b' }}>{messagePreview(message)}</div>
                      <div style={{ fontSize: 12, color: theme.colors.muted, marginTop: 4 }}>{formatDateTime(Number(message.createdAt ?? Date.now()))}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div
          style={{
            borderRadius: 12,
            border: '1px solid rgba(59, 130, 246, 0.34)',
            background: 'linear-gradient(165deg, rgba(239,246,255,0.96) 0%, rgba(224,231,255,0.96) 50%, rgba(250,245,255,0.96) 100%)',
            padding: 14,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 18, marginBottom: 8, color: '#1e3a8a' }}>Продолжить работу</div>
          <div style={{ color: '#334155', marginBottom: 10 }}>Последние разделы и карточки из предыдущих сессий.</div>
          {rightColumnVisits.length === 0 ? (
            <div style={{ color: theme.colors.muted }}>История переходов пока пустая.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {rightColumnVisits.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => props.onNavigate(entry.link)}
                  style={{
                    textAlign: 'left',
                    border: '1px solid rgba(59, 130, 246, 0.25)',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.92)',
                    padding: '10px 12px',
                    cursor: 'pointer',
                    boxShadow: '0 6px 20px rgba(30,64,175,0.08)',
                  }}
                  title={entry.title}
                >
                  <div style={{ fontWeight: 700, color: '#0f172a' }}>{entry.title}</div>
                  <div style={{ marginTop: 4, fontSize: 12, color: '#475569' }}>
                    {formatAgo(entry.at)} • {formatDateTime(entry.at)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

