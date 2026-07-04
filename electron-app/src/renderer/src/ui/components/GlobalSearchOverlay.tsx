import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { globalSearchKindLabel, type GlobalSearchHit, type GlobalSearchKind } from '@matricarmz/shared';

import { useGlobalSearchScope } from '../context/globalSearchScope.js';
import { L2_SOURCES, loadAllL2, pickL2Label, type L2Row } from '../services/globalSearchSources.js';
import { KIND_PATH, UI_SEARCH_ENTRIES, type UiSearchEntry } from '../services/uiSearchRegistry.js';
import { filterPreparedRecords, prepareRecordSearch, type PreparedRecordSearch } from '../utils/search.js';

type LevelMode = 'auto' | 'page' | 'directories' | 'server';

const LEVELS: Array<{ mode: LevelMode; label: string }> = [
  { mode: 'auto', label: 'Авто' },
  { mode: 'page', label: 'Эта страница' },
  { mode: 'directories', label: 'Справочники' },
  { mode: 'server', label: 'Сервер' },
];

// Group display order; kinds not listed fall to the end in encounter order.
const KIND_ORDER: GlobalSearchKind[] = [
  'nomenclature',
  'engine',
  'engine_brand',
  'contract',
  'counterparty',
  'employee',
  'work_order',
  'request',
  'service',
  'product',
  'tool',
  'tool_property',
  'stock_document',
];

// Deep card-content search (tier L2.5) runs over EAV-backed entity kinds only —
// nomenclature/stock documents are erp_* tables without attribute_values.
const DEEP_KINDS: GlobalSearchKind[] = [
  'engine',
  'employee',
  'request',
  'work_order',
  'tool',
  'tool_property',
  'engine_brand',
  'counterparty',
  'contract',
  'service',
  'product',
];

const PER_GROUP = 6;
const SERVER_DEBOUNCE_MS = 250;
const DEEP_DEBOUNCE_MS = 300;
const SERVER_MIN_CHARS = 2;

// Unified result row: an entity hit (opens the card) or a UI surface (opens the tab).
type RowItem = {
  key: string;
  label: string;
  code?: string;
  path?: string;
  note?: string;
  hit?: GlobalSearchHit;
  tabId?: string;
};

export function GlobalSearchOverlay(props: {
  open: boolean;
  onClose: () => void;
  onSelect: (hit: GlobalSearchHit) => void;
  onNavigateTab?: (tabId: string) => void;
}) {
  const { open, onClose, onSelect, onNavigateTab } = props;
  const scope = useGlobalSearchScope();

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<LevelMode>('auto');
  const [l2Loaded, setL2Loaded] = useState<Partial<Record<GlobalSearchKind, L2Row[]>>>({});
  const [serverHits, setServerHits] = useState<GlobalSearchHit[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [deepIds, setDeepIds] = useState<Set<string>>(new Set());
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  // Reset + focus on open; load L2 directories once per open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setMode('auto');
    setActiveIndex(0);
    setServerHits([]);
    setDeepIds(new Set());
    const focus = window.setTimeout(() => inputRef.current?.focus(), 0);
    let cancelled = false;
    void (async () => {
      const loaded = await loadAllL2();
      if (!cancelled) setL2Loaded(loaded);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(focus);
    };
  }, [open]);

  // Debounced, abortable L3 server search.
  useEffect(() => {
    if (!open || !(mode === 'auto' || mode === 'server')) {
      setServerHits([]);
      setServerLoading(false);
      return;
    }
    const q = query.trim();
    if (q.length < SERVER_MIN_CHARS) {
      setServerHits([]);
      setServerLoading(false);
      return;
    }
    let cancelled = false;
    setServerLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.matrica.search.global({ q, limit: 12 });
        if (!cancelled) setServerHits(Array.isArray(res?.hits) ? res.hits : []);
      } catch {
        if (!cancelled) setServerHits([]);
      } finally {
        if (!cancelled) setServerLoading(false);
      }
    }, SERVER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, mode, query]);

  // Debounced L2.5 deep search inside card content (live EAV values in local SQLite)
  // across the already-loaded directory rows — «ищет и в карточках, и в базе».
  useEffect(() => {
    if (!open || !(mode === 'auto' || mode === 'directories')) {
      setDeepIds(new Set());
      return;
    }
    const q = query.trim();
    if (q.length < SERVER_MIN_CHARS) {
      setDeepIds(new Set());
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const entityIds: string[] = [];
        for (const kind of DEEP_KINDS) {
          for (const r of l2Loaded[kind] ?? []) {
            const id = String((r as L2Row).id ?? '');
            if (id) entityIds.push(id);
          }
        }
        if (entityIds.length === 0) return;
        const res = await window.matrica.search.cardContent({ entityIds, q });
        if (!cancelled) setDeepIds(res.ok ? new Set(res.ids) : new Set());
      } catch {
        if (!cancelled) setDeepIds(new Set());
      }
    }, DEEP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, mode, query, l2Loaded]);

  const l2Prepared = useMemo(() => {
    const out: Partial<Record<GlobalSearchKind, PreparedRecordSearch<L2Row>>> = {};
    for (const src of L2_SOURCES) {
      const rows = l2Loaded[src.kind] ?? [];
      out[src.kind] = prepareRecordSearch(rows, (r) => String((r as L2Row).id ?? ''), (r) => pickL2Label(r as L2Row));
    }
    return out;
  }, [l2Loaded]);

  const l1Prepared = useMemo(() => {
    if (!scope) return null;
    return prepareRecordSearch(scope.rows, scope.getId, scope.getLabel);
  }, [scope]);

  const uiPrepared = useMemo(
    () =>
      prepareRecordSearch(
        UI_SEARCH_ENTRIES,
        (e) => `${e.tabId}|${e.label}`,
        (e) => `${e.label} ${(e.synonyms ?? []).join(' ')}`,
      ),
    [],
  );

  const hits = useMemo<GlobalSearchHit[]>(() => {
    const q = query.trim();
    if (!q) return [];
    const showL1 = (mode === 'auto' || mode === 'page') && !!scope && !!l1Prepared;
    const showL2 = mode === 'auto' || mode === 'directories';
    const showL3 = mode === 'auto' || mode === 'server';
    const out: GlobalSearchHit[] = [];

    if (showL1 && scope && l1Prepared) {
      for (const r of filterPreparedRecords(l1Prepared, q).records.slice(0, PER_GROUP)) {
        const id = scope.getId(r);
        if (!id) continue;
        out.push({ kind: scope.kind, id, label: scope.getLabel(r) || id });
      }
    }
    if (showL2) {
      for (const src of L2_SOURCES) {
        const prep = l2Prepared[src.kind];
        if (!prep) continue;
        for (const r of filterPreparedRecords(prep, q).records.slice(0, PER_GROUP)) {
          const id = String(r.id ?? '');
          if (!id) continue;
          const code = src.getCode?.(r) ?? '';
          out.push({ kind: src.kind, id, label: pickL2Label(r) || id, ...(code ? { code } : {}) });
        }
      }
    }
    if (showL3) out.push(...serverHits);

    const seen = new Set<string>();
    return out.filter((h) => {
      const key = `${h.kind}|${h.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [query, mode, scope, l1Prepared, l2Prepared, serverHits]);

  // Deep-only hits: ids matched inside card content that tier-1/2/3 did not surface.
  const deepHits = useMemo<GlobalSearchHit[]>(() => {
    if (deepIds.size === 0) return [];
    const already = new Set(hits.map((h) => h.id));
    const out: GlobalSearchHit[] = [];
    for (const kind of DEEP_KINDS) {
      for (const r of l2Loaded[kind] ?? []) {
        const id = String((r as L2Row).id ?? '');
        if (!id || !deepIds.has(id) || already.has(id)) continue;
        out.push({ kind, id, label: pickL2Label(r as L2Row) || id });
        if (out.length >= PER_GROUP * 2) return out;
      }
    }
    return out;
  }, [deepIds, hits, l2Loaded]);

  const uiRows = useMemo<UiSearchEntry[]>(() => {
    const q = query.trim();
    if (!q || !(mode === 'auto' || mode === 'page')) return [];
    return filterPreparedRecords(uiPrepared, q).records.slice(0, PER_GROUP);
  }, [query, mode, uiPrepared]);

  const groups = useMemo(() => {
    const ordered: Array<{ key: string; title: string; rows: RowItem[] }> = [];

    if (uiRows.length) {
      ordered.push({
        key: '__ui',
        title: 'Интерфейс',
        rows: uiRows.map((e) => ({
          key: `ui|${e.tabId}|${e.label}`,
          label: e.label,
          path: e.path,
          note: e.surface,
          tabId: e.tabId,
        })),
      });
    }

    const byKind = new Map<GlobalSearchKind, GlobalSearchHit[]>();
    for (const h of hits) {
      const arr = byKind.get(h.kind) ?? [];
      if (arr.length < PER_GROUP) arr.push(h);
      byKind.set(h.kind, arr);
    }
    const toRows = (arr: GlobalSearchHit[]): RowItem[] =>
      arr.map((h) => ({
        key: `${h.kind}|${h.id}`,
        label: h.label,
        ...(h.code ? { code: h.code } : {}),
        path: KIND_PATH[h.kind],
        hit: h,
      }));
    const used = new Set<GlobalSearchKind>();
    for (const kind of KIND_ORDER) {
      const arr = byKind.get(kind);
      if (arr && arr.length) {
        ordered.push({ key: kind, title: groupTitle(kind, scope), rows: toRows(arr) });
        used.add(kind);
      }
    }
    for (const [kind, arr] of byKind) {
      if (!used.has(kind) && arr.length) ordered.push({ key: kind, title: groupTitle(kind, scope), rows: toRows(arr) });
    }

    if (deepHits.length) {
      ordered.push({
        key: '__deep',
        title: 'Найдено в содержимом карточек',
        rows: deepHits.map((h) => ({
          key: `deep|${h.kind}|${h.id}`,
          label: h.label,
          path: KIND_PATH[h.kind],
          note: globalSearchKindLabel(h.kind).toLowerCase(),
          hit: h,
        })),
      });
    }
    return ordered;
  }, [uiRows, hits, deepHits, scope]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const pick = (row: RowItem) => {
    if (row.hit) {
      onSelect(row.hit);
      return;
    }
    if (row.tabId && onNavigateTab) {
      onClose();
      onNavigateTab(row.tabId);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i + 1, flat.length - 1)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = flat[activeIndex];
      if (row) pick(row);
    }
  };

  const q = query.trim();
  let flatCursor = 0;

  const node = (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.45)',
        zIndex: 6000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '9vh',
      }}
    >
      <div
        data-testid="global-search-overlay"
        onKeyDown={onKeyDown}
        style={{
          width: 'min(720px, 92vw)',
          maxHeight: '74vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: 'var(--chat-menu-shadow, 0 24px 60px rgba(15,23,42,0.35))',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <input
            ref={inputRef}
            data-testid="global-search-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder="Поиск по всему: детали, двигатели, наряды, кнопки и разделы…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 12px',
              fontSize: 16,
              color: 'var(--text)',
              background: 'var(--input-bg, var(--surface2))',
              border: '1px solid var(--input-border, var(--border))',
              borderRadius: 8,
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            {LEVELS.map((lvl) => {
              const activeLevel = lvl.mode === mode;
              return (
                <button
                  key={lvl.mode}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setMode(lvl.mode)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: activeLevel ? '#fff' : 'var(--muted)',
                    background: activeLevel ? 'var(--accent, #2563eb)' : 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                  }}
                >
                  {lvl.label}
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 0' }}>
          {q.length === 0 && (
            <div style={{ padding: '18px 16px', color: 'var(--muted)', fontSize: 14 }}>Начните вводить запрос…</div>
          )}
          {q.length > 0 && flat.length === 0 && (
            <div style={{ padding: '18px 16px', color: 'var(--muted)', fontSize: 14 }}>
              {serverLoading ? 'Поиск…' : 'Ничего не найдено'}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.key}>
              <div
                style={{
                  padding: '8px 16px 4px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  color: 'var(--muted)',
                }}
              >
                {group.title}
              </div>
              {group.rows.map((row) => {
                const idx = flatCursor;
                flatCursor += 1;
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={row.key}
                    ref={isActive ? activeRowRef : null}
                    data-testid="global-search-row"
                    data-kind={row.hit ? row.hit.kind : 'ui'}
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(row)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      gap: 2,
                      width: '100%',
                      textAlign: 'left',
                      padding: '7px 16px',
                      border: 'none',
                      cursor: 'pointer',
                      background: isActive ? 'var(--surface2)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.label}
                      </span>
                      {row.code ? <span style={{ flex: '0 0 auto', fontSize: 12, color: 'var(--muted)' }}>{row.code}</span> : null}
                      {row.note ? <span style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--muted)' }}>{row.note}</span> : null}
                    </span>
                    {row.path ? (
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--muted)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.path}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div
          style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--border)',
            fontSize: 12,
            color: 'var(--muted)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>↑↓ выбрать · Enter открыть · Esc закрыть</span>
          {serverLoading ? <span>сервер…</span> : null}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

function groupTitle(kind: GlobalSearchKind, scope: { kind: GlobalSearchKind; title: string } | null): string {
  if (scope && scope.kind === kind && scope.title) return `${globalSearchKindLabel(kind)} · ${scope.title}`;
  return globalSearchKindLabel(kind);
}
