import React, { useEffect, useMemo, useRef, useState } from 'react';

export type SearchSelectOption = { id: string; label: string };

export function SearchSelect(props: {
  value: string | null;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string | null) => void;
}) {
  const disabled = props.disabled === true;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => {
    if (!props.value) return null;
    return props.options.find((o) => o.id === props.value) ?? null;
  }, [props.options, props.value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [props.options, query]);

  useEffect(() => {
    if (!open) return;
    if (!filtered.length) {
      setActiveIdx(-1);
      return;
    }
    const idx = props.value ? filtered.findIndex((o) => o.id === props.value) : -1;
    setActiveIdx(idx >= 0 ? idx : 0);
  }, [open, props.value, filtered]);

  useEffect(() => {
    if (!open) return;
    if (!filtered.length) {
      setActiveIdx(-1);
      return;
    }
    setActiveIdx((prev) => {
      if (prev < 0) return 0;
      if (prev >= filtered.length) return filtered.length - 1;
      return prev;
    });
  }, [filtered, open]);

  useEffect(() => {
    if (!open) return;
    if (activeIdx < 0) return;
    const host = listRef.current;
    if (!host) return;
    const el = host.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null;
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const viewTop = host.scrollTop;
    const viewBottom = viewTop + host.clientHeight;
    if (top < viewTop) host.scrollTop = top;
    else if (bottom > viewBottom) host.scrollTop = bottom - host.clientHeight;
  }, [activeIdx, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      if (e.target && el.contains(e.target as any)) return;
      setOpen(false);
      setQuery('');
      setActiveIdx(-1);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function close() {
    setOpen(false);
    setQuery('');
    setActiveIdx(-1);
  }

  function openOrToggle() {
    if (disabled) return;
    setOpen((v) => {
      const next = !v;
      if (!next) {
        setQuery('');
        setActiveIdx(-1);
      }
      return next;
    });
  }

  function pickByIndex(idx: number) {
    const o = filtered[idx];
    if (!o) return;
    props.onChange(o.id);
    close();
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          onClick={openOrToggle}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openOrToggle();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          style={{
            flex: 1,
            padding: '8px 10px',
            borderRadius: 10,
            border: '1px solid #d1d5db',
            background: disabled ? '#f3f4f6' : '#fff',
            cursor: disabled ? 'not-allowed' : 'pointer',
            color: '#111827',
            display: 'flex',
            alignItems: 'center',
            minHeight: 36,
          }}
          title={selected?.id ?? ''}
        >
          <span style={{ color: selected ? '#111827' : '#6b7280' }}>{selected ? selected.label : props.placeholder ?? '(не выбрано)'}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: '#6b7280' }}>{open ? '▲' : '▼'}</span>
        </div>

        {!disabled && (
          <button
            type="button"
            onClick={() => {
              props.onChange(null);
              close();
            }}
            style={{
              padding: '8px 10px',
              borderRadius: 10,
              border: '1px solid rgba(15, 23, 42, 0.25)',
              background: 'rgba(255,255,255,0.90)',
              cursor: 'pointer',
              color: '#6b7280',
              minHeight: 36,
            }}
            title="Очистить"
          >
            ✕
          </button>
        )}
      </div>

      {open && !disabled && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 'calc(100% + 6px)',
            zIndex: 10,
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 12,
            boxShadow: '0 18px 40px rgba(0,0,0,0.15)',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid #f3f4f6' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  close();
                  return;
                }
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (!filtered.length) return;
                  setActiveIdx((p) => (p < 0 ? 0 : Math.min(filtered.length - 1, p + 1)));
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (!filtered.length) return;
                  setActiveIdx((p) => (p <= 0 ? 0 : p - 1));
                  return;
                }
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (activeIdx >= 0) pickByIndex(activeIdx);
                }
              }}
              placeholder="Поиск…"
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid #d1d5db',
                outline: 'none',
              }}
              autoFocus
            />
          </div>
          <div ref={listRef} style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: 12, color: '#6b7280' }}>Ничего не найдено</div>}
            {filtered.map((o, idx) => {
              const active = props.value === o.id;
              const focused = activeIdx === idx;
              return (
                <div
                  key={o.id}
                  data-idx={idx}
                  onClick={() => {
                    props.onChange(o.id);
                    close();
                  }}
                  onMouseEnter={() => {
                    setActiveIdx(idx);
                  }}
                  style={{
                    padding: '10px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #f3f4f6',
                    background: focused ? '#e0f2fe' : active ? '#eef2ff' : '#fff',
                  }}
                >
                  <div style={{ fontWeight: 700, color: '#111827' }}>{o.label}</div>
                  <div style={{ marginTop: 2, fontSize: 12, color: '#6b7280', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {o.id.slice(0, 8)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

