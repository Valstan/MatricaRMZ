import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import { globalSearchKindLabel, type GlobalSearchHit, type GlobalSearchKind } from '@matricarmz/shared';

import { useGlobalSearchScope } from '../context/globalSearchScope.js';
import { L2_SOURCES, loadAllL2, pickL2Label, type L2Row } from '../services/globalSearchSources.js';
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

const PER_GROUP = 6;
const SERVER_DEBOUNCE_MS = 250;
const SERVER_MIN_CHARS = 2;

export function GlobalSearchOverlay(props: { open: boolean; onClose: () => void; onSelect: (hit: GlobalSearchHit) => void }) {
  const { open, onClose, onSelect } = props;
  const scope = useGlobalSearchScope();

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<LevelMode>('auto');
  const [l2Loaded, setL2Loaded] = useState<Partial<Record<GlobalSearchKind, L2Row[]>>>({});
  const [serverHits, setServerHits] = useState<GlobalSearchHit[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
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

  const groups = useMemo(() => {
    const byKind = new Map<GlobalSearchKind, GlobalSearchHit[]>();
    for (const h of hits) {
      const arr = byKind.get(h.kind) ?? [];
      if (arr.length < PER_GROUP) arr.push(h);
      byKind.set(h.kind, arr);
    }
    const ordered: Array<{ kind: GlobalSearchKind; title: string; hits: GlobalSearchHit[] }> = [];
    const used = new Set<GlobalSearchKind>();
    for (const kind of KIND_ORDER) {
      const arr = byKind.get(kind);
      if (arr && arr.length) {
        ordered.push({ kind, title: groupTitle(kind, scope), hits: arr });
        used.add(kind);
      }
    }
    for (const [kind, arr] of byKind) {
      if (!used.has(kind) && arr.length) ordered.push({ kind, title: groupTitle(kind, scope), hits: arr });
    }
    return ordered;
  }, [hits, scope]);

  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

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
      const hit = flat[activeIndex];
      if (hit) onSelect(hit);
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
            placeholder="Поиск по всему: детали, двигатели, контрагенты, наряды…"
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
            <div key={group.kind}>
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
              {group.hits.map((hit) => {
                const idx = flatCursor;
                flatCursor += 1;
                const isActive = idx === activeIndex;
                return (
                  <button
                    key={`${hit.kind}|${hit.id}`}
                    ref={isActive ? activeRowRef : null}
                    data-testid="global-search-row"
                    data-kind={hit.kind}
                    type="button"
                    onMouseEnter={() => setActiveIndex(idx)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onSelect(hit)}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 16px',
                      border: 'none',
                      cursor: 'pointer',
                      background: isActive ? 'var(--surface2)' : 'transparent',
                      color: 'var(--text)',
                    }}
                  >
                    <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {hit.label}
                    </span>
                    {hit.code ? <span style={{ flex: '0 0 auto', fontSize: 12, color: 'var(--muted)' }}>{hit.code}</span> : null}
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
