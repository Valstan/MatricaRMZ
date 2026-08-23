import React, { useEffect, useMemo, useState } from 'react';

import type { ChatDeepLinkPayload, ChatMessageItem, DesktopShortcut, NoteItem, NoteShareItem } from '@matricarmz/shared';
import { type ContractActivityAlert } from '@matricarmz/shared';

import { loadContractActivityAlerts } from '../utils/contractAlerts.js';

import { theme } from '../theme.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';
import { pollWhenVisible } from '../utils/pollWhenVisible.js';
import { TAB_SHORTCUT_META, resolveQuickStartTile, type PinnedTile } from '../utils/favoriteShortcut.js';
import { useTabVisibleRef } from '../shell/TabVisibilityContext.js';
import { TieIcon } from '../components/TieIcon.js';

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
  tab: string;
  gradient: string;
};

function formatDateTime(ms: number) {
  try {
    return formatMoscowDateTime(ms);
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


export const __historyPageTestUtils = {
  resolveShortcutTile: resolveQuickStartTile,
};

export function HistoryPage(props: {
  meUserId: string;
  recentVisits: RecentVisitEntry[];
  quickStartRatings?: Array<{ tab: string; score: number; lastAt?: number }>;
  /** Живые ярлыки Рабочего стола — «Мой круг» показывает их же (одно место для закладок). */
  desktopShortcuts?: DesktopShortcut[];
  /** Убрать ярлык со стола (в корзину) — тот же смысл, что у корзины на самом столе. */
  onRemoveShortcut?: (shortcutId: string) => void;
  onNavigate: (link: ChatDeepLinkPayload) => void;
  onOpenNotes: (noteId?: string | null) => void;
  onOpenChat: () => void;
}) {
  // «История» — посадочный раздел, её вкладка открыта почти всегда: скрытой она
  // поллила бы фоном при любом переключении.
  const tabVisibleRef = useTabVisibleRef();
  const [notes, setNotes] = useState<NoteView[]>([]);
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [pinnedContextMenu, setPinnedContextMenu] = useState<{ x: number; y: number; shortcutId: string } | null>(null);
  const [contractAlerts, setContractAlerts] = useState<ContractActivityAlert[]>([]);

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
    // Плитки «последние заметки/сообщения» — визуальные; свёрнутое окно и скрытую
    // вкладку не опрашиваем (латч в колбэке: подписка mount-only).
    const stop = pollWhenVisible(() => {
      if (!tabVisibleRef.current) return;
      void load();
    }, 20_000);
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tabVisibleRef is a stable ref read inside the mount-only poll callback; adding it would resubscribe on every render
  }, [props.meUserId]);

  // Плитки = ярлыки стола со ссылкой на раздел/карточку. Файловые ярлыки (этап D) здесь
  // не показываем — открыть их отсюда нечем.
  const pinnedTiles = useMemo(() => {
    const tiles: PinnedTile[] = [];
    for (const s of props.desktopShortcuts ?? []) {
      const link = asAppLink(s.link);
      if (!link) continue;
      const meta = TAB_SHORTCUT_META[String(link.tab)];
      const gradient = link.tab === 'report_preset'
        ? 'linear-gradient(135deg, #be185d 0%, #ec4899 100%)'
        : meta?.gradient ?? 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)';
      tiles.push({ shortcutId: s.id, icon: s.icon, title: s.label, gradient, link });
    }
    return tiles;
  }, [props.desktopShortcuts]);

  // Напоминание «заведён новый контракт/ДС — привязать двигатели». Производное от
  // createdAt (окно 3 дня) → гаснет само, без состояния «прочитано». Грузим только
  // недавно-тронутые контракты (updatedAt в окне) — добавление ДС бампит updatedAt.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const alerts = await loadContractActivityAlerts();
        if (alive) setContractAlerts(alerts.slice(0, 6));
      } catch {
        if (alive) setContractAlerts([]);
      }
    };
    void load();
    const stop = pollWhenVisible(() => {
      if (!tabVisibleRef.current) return;
      void load();
    }, 60_000);
    return () => {
      alive = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only poll; tabVisibleRef is a stable ref read inside the callback
  }, []);

  useEffect(() => {
    if (!pinnedContextMenu) return;
    const handler = () => {
      setPinnedContextMenu(null);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinnedContextMenu(null);
    };
    window.addEventListener('mousedown', handler, true);
    window.addEventListener('keydown', keyHandler, true);
    return () => {
      window.removeEventListener('mousedown', handler, true);
      window.removeEventListener('keydown', keyHandler, true);
    };
  }, [pinnedContextMenu]);

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
      {
        id: 'contracts',
        icon: '📑',
        title: 'Контракты',
        subtitle: 'Договоры и исполнение',
        tab: 'contracts',
        gradient: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)',
      },
      {
        id: 'counterparties',
        icon: '🤝',
        title: 'Контрагенты',
        subtitle: 'Партнеры и заказчики',
        tab: 'counterparties',
        gradient: 'linear-gradient(135deg, #0f172a 0%, #334155 100%)',
      },
      {
        id: 'tool_accounting',
        icon: '📋',
        title: 'Учёт инструментов',
        subtitle: 'Выдачи и возвраты',
        tab: 'tool_accounting',
        gradient: 'linear-gradient(135deg, #047857 0%, #34d399 100%)',
      },
      {
        id: 'employees',
        icon: '👥',
        title: 'Сотрудники',
        subtitle: 'Кадры и доступы',
        tab: 'employees',
        gradient: 'linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)',
      },
      {
        id: 'settings',
        icon: '⚡',
        title: 'Настройки',
        subtitle: 'Параметры клиента',
        tab: 'settings',
        gradient: 'linear-gradient(135deg, #111827 0%, #4b5563 100%)',
      },
    ],
    [],
  );

  const recentByTab = useMemo(() => {
    const out = new Map<string, number>();
    for (const visit of rightColumnVisits) {
      const key = String(visit.link?.tab ?? '');
      out.set(key, Number(out.get(key) ?? 0) + 1);
    }
    return out;
  }, [rightColumnVisits]);
  const ratingByTab = useMemo(() => {
    const out = new Map<string, number>();
    for (const row of props.quickStartRatings ?? []) {
      const tab = String(row?.tab ?? '').trim();
      if (!tab) continue;
      const score = Number(row?.score ?? 0);
      if (!Number.isFinite(score) || score <= 0) continue;
      out.set(tab, score);
    }
    return out;
  }, [props.quickStartRatings]);

  const visibleQuickTiles = useMemo(() => {
    const ranked = quickStartTiles.map((tile, index) => ({
      tile,
      rating: Number(ratingByTab.get(tile.tab) ?? 0),
      recent: Number(recentByTab.get(tile.tab) ?? 0),
      index,
    }));
    ranked.sort((a, b) => b.rating - a.rating || b.recent - a.recent || a.index - b.index);

    const top = ranked
      .filter((row) => row.rating > 0 || row.recent > 0)
      .slice(0, 3)
      .map((row) => row.tile);

    if (top.length >= 3) return top;
    const seen = new Set(top.map((tile) => tile.id));
    for (const row of ranked) {
      if (seen.has(row.tile.id)) continue;
      top.push(row.tile);
      seen.add(row.tile.id);
      if (top.length >= 3) break;
    }
    return top;
  }, [quickStartTiles, ratingByTab, recentByTab]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {contractAlerts.length > 0 && (
        <div
          style={{
            borderRadius: 14,
            border: '1px solid rgba(245, 158, 11, 0.45)',
            background: 'rgba(245, 158, 11, 0.08)',
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 15, color: '#92400e', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span aria-hidden="true">🔔</span> Новые контракты и ДС — не забудьте привязать двигатели
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {contractAlerts.map((a) => {
              const label =
                a.kind === 'contract'
                  ? `Заведён новый контракт ${a.contractNumber}`
                  : `Заведено новое ДС ${a.seq} в контракте ${a.contractNumber}`;
              return (
                <button
                  key={`${a.kind}:${a.contractId}:${a.seq ?? 0}`}
                  type="button"
                  onClick={() =>
                    props.onNavigate({ kind: 'app_link', tab: 'contract', contractId: a.contractId, breadcrumbs: ['Контракты', a.contractNumber] })
                  }
                  style={{
                    textAlign: 'left',
                    border: '1px solid rgba(245, 158, 11, 0.3)',
                    background: '#ffffff',
                    borderRadius: 8,
                    padding: '8px 10px',
                    cursor: 'pointer',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 13, color: '#7c2d12' }}>{label}</span>
                  <span style={{ fontSize: 11, color: '#b45309', whiteSpace: 'nowrap' }}>{formatAgo(a.createdAt)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {pinnedTiles.length > 0 && (
        <div
          style={{
            borderRadius: 14,
            border: '1px solid rgba(16, 185, 129, 0.35)',
            background:
              'radial-gradient(circle at 10% 20%, rgba(16, 185, 129, 0.12), transparent 40%), radial-gradient(circle at 90% 80%, rgba(59, 130, 246, 0.10), transparent 42%), #ffffff',
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 800, fontSize: 17, color: '#065f46', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <TieIcon active size={18} />
            Ярлыки Рабочего стола
          </div>
          <div style={{ color: theme.colors.muted, fontSize: 12, marginBottom: 10 }}>Те же ярлыки, что лежат на Рабочем столе: галстук на вкладке кладёт их сюда и туда разом.</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: 10,
            }}
          >
            {pinnedTiles.map((tile) => (
              <button
                key={tile.shortcutId}
                type="button"
                onClick={() => props.onNavigate(tile.link)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setPinnedContextMenu({ x: e.clientX, y: e.clientY, shortcutId: tile.shortcutId });
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
                  minHeight: 66,
                  width: '100%',
                }}
                title={`${tile.title} (правый клик — убрать с Рабочего стола)`}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 4, alignItems: 'center', minWidth: 0 }}>
                  <span style={{ gridRow: 1, gridColumn: 1, fontSize: 20, lineHeight: 1 }}>{tile.icon}</span>
                  <span style={{ gridRow: 1, gridColumn: 2, fontSize: 14, fontWeight: 800, lineHeight: 1.1, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>{tile.title}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {pinnedContextMenu && (
        <div
          style={{
            position: 'fixed',
            left: pinnedContextMenu.x,
            top: pinnedContextMenu.y,
            zIndex: 13000,
            minWidth: 200,
            background: 'var(--surface, #fff)',
            border: '1px solid var(--border)',
            boxShadow: '0 16px 40px rgba(15,23,42,0.18)',
            borderRadius: 10,
            padding: 6,
          }}
        >
          <button
            type="button"
            onClick={() => {
              props.onRemoveShortcut?.(pinnedContextMenu.shortcutId);
              setPinnedContextMenu(null);
            }}
            style={{
              width: '100%',
              textAlign: 'left',
              border: '1px solid transparent',
              background: 'transparent',
              color: 'var(--danger, #dc2626)',
              padding: '8px 10px',
              cursor: 'pointer',
              fontSize: 13,
              borderRadius: 6,
            }}
          >
            Убрать с Рабочего стола (в корзину)
          </button>
        </div>
      )}

      <div
        style={{
          borderRadius: 14,
          border: '1px solid rgba(59, 130, 246, 0.25)',
          background:
            'radial-gradient(circle at 8% 15%, rgba(125, 211, 252, 0.15), transparent 40%), radial-gradient(circle at 92% 80%, rgba(196, 181, 253, 0.18), transparent 42%), #ffffff',
          padding: 12,
        }}
      >
        <div style={{ fontWeight: 800, fontSize: 17, color: '#1e3a8a', marginBottom: 8 }}>Часто используемое</div>
        <div style={{ fontSize: 13, color: '#475569', marginBottom: 10 }}>
          Показаны 3 самых часто используемых раздела для вашего пользователя.
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          {visibleQuickTiles.map((tile) => {
            const recentCount = Number(recentByTab.get(tile.tab) ?? 0);
            const rating = Number(ratingByTab.get(tile.tab) ?? 0);
            return (
              <button
                key={tile.id}
                type="button"
                onClick={() => {
                  props.onNavigate({
                    kind: 'app_link',
                    tab: tile.tab as ChatDeepLinkPayload['tab'],
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
                  width: 'fit-content',
                  maxWidth: 260,
                }}
                title={tile.title}
              >
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 4, alignItems: 'center', minWidth: 0 }}>
                  <span style={{ gridRow: 1, gridColumn: 1, fontSize: 22, lineHeight: 1 }}>{tile.icon}</span>
                  <span style={{ gridRow: 1, gridColumn: 2, fontSize: 15, fontWeight: 800, lineHeight: 1.1, overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>{tile.title}</span>
                  <div style={{ gridRow: 2, gridColumn: '1 / -1', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                    {tile.subtitle ? <span style={{ fontSize: 12, opacity: 0.95 }}>{tile.subtitle}</span> : null}
                    {rating > 0 ? (
                      <span
                        style={{
                          fontSize: 11,
                          borderRadius: 999,
                          padding: '2px 7px',
                          background: 'rgba(255,255,255,0.24)',
                          fontWeight: 700,
                        }}
                      >
                        рейтинг {rating}
                      </span>
                    ) : null}
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
                  </div>
                </div>
              </button>
            );
          })}
        </div>
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

