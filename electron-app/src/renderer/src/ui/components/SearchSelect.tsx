import React, { useEffect, useMemo, useRef, useState } from 'react';

export type SearchSelectOption = { id: string; label: string };

export function SearchSelect(props: {
  value: string | null;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string | null) => void;
  onCreate?: (label: string) => Promise<string | null>;
  createLabel?: string;
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

  // When opening, initialize active item to current selection if possible.
  useEffect(() => {
    if (!open) return;
    if (!filtered.length) {
      setActiveIdx(-1);
      return;
    }
    const idx = props.value ? filtered.findIndex((o) => o.id === props.value) : -1;
    setActiveIdx(idx >= 0 ? idx : 0);
  }, [open, props.value, filtered]);

  // Keep active index valid when filtering changes.
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

  // Ensure active item is visible (scroll into view) when navigating.
  useEffect(() => {
    if (!open) return;
    if (activeIdx < 0) return;
    const host = listRef.current;
    if (!host) return;
    const el = host.querySelector(`[data-idx="${activeIdx}"]`) as HTMLElement | null;
    if (!el) return;
    // Minimal scroll-into-view for containers.
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
            border: '1px solid var(--input-border)',
            background: disabled ? 'var(--input-bg-disabled)' : 'var(--input-bg)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            color: 'var(--text)',
            display: 'flex',
            alignItems: 'center',
            minHeight: 36,
          }}
          title={selected?.id ?? ''}
        >
          <span style={{ color: selected ? 'var(--text)' : 'var(--muted)' }}>
            {selected ? selected.label : props.placeholder ?? '(не выбрано)'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
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
              border: '1px solid var(--button-ghost-border)',
              background: 'var(--button-ghost-bg)',
              cursor: 'pointer',
              color: 'var(--muted)',
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
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: 'var(--chat-menu-shadow)',
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
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
                  setActiveIdx((p) => {
                    const next = p < 0 ? 0 : Math.min(filtered.length - 1, p + 1);
                    return next;
                  });
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (!filtered.length) return;
                  setActiveIdx((p) => {
                    const next = p <= 0 ? 0 : p - 1;
                    return next;
                  });
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
                border: '1px solid var(--input-border)',
                background: 'var(--input-bg)',
                color: 'var(--text)',
                outline: 'none',
              }}
              autoFocus
            />
          </div>
          <div ref={listRef} style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: 12, color: 'var(--muted)' }}>Ничего не найдено</div>}
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
                    borderBottom: '1px solid var(--border)',
                    background: focused ? 'rgba(96, 165, 250, 0.18)' : active ? 'rgba(129, 140, 248, 0.18)' : 'transparent',
                  }}
                >
                  <div style={{ fontWeight: 700, color: 'var(--text)' }}>{o.label}</div>
                  <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {o.id.slice(0, 8)}
                  </div>
                </div>
              );
            })}
            {props.onCreate && (
              <div
                onClick={async () => {
                  const label = window.prompt(props.createLabel ?? 'Добавить');
                  if (!label?.trim()) return;
                  const id = await props.onCreate?.(label.trim());
                  if (!id) return;
                  props.onChange(id);
                  close();
                }}
                style={{
                  padding: '10px 12px',
                  cursor: 'pointer',
                  borderTop: '1px dashed var(--border)',
                  background: 'transparent',
                }}
              >
                <div style={{ fontWeight: 700, color: 'var(--text)' }}>+ Добавить</div>
                {props.createLabel && <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)' }}>{props.createLabel}</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}


