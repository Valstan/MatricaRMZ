import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type MultiSearchSelectOption = { id: string; label: string };

export function MultiSearchSelect(props: {
  values: string[];
  options: MultiSearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const disabled = props.disabled === true;
  const safeValues = Array.isArray(props.values) ? props.values : [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [popupRect, setPopupRect] = useState<{ left: number; top: number; width: number } | null>(null);

  const selected = useMemo(() => {
    const set = new Set(safeValues);
    return props.options.filter((o) => set.has(o.id));
  }, [props.options, safeValues]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.options;
    return props.options.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [props.options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const el = rootRef.current;
      if (!el) return;
      const target = e.target as Node | null;
      if (target && (el.contains(target) || popupRef.current?.contains(target))) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopupRect({ left: rect.left, top: rect.bottom + 6, width: rect.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [open]);

  function toggle(id: string) {
    const set = new Set(safeValues);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    props.onChange(Array.from(set));
  }

  function clearAll() {
    props.onChange([]);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          onClick={() => !disabled && setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setOpen(false);
              setQuery('');
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
          title={selected.map((s) => s.label).join(', ')}
        >
          <span style={{ color: selected.length ? 'var(--text)' : 'var(--muted)' }}>
            {selected.length ? selected.map((s) => s.label).join(', ') : props.placeholder ?? '(не выбрано)'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
        </div>

        {!disabled && (
          <button
            type="button"
            onClick={clearAll}
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

      {open && !disabled && popupRect
        ? createPortal(
            <div
              ref={popupRef}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: popupRect.left,
                top: popupRect.top,
                width: popupRect.width,
                zIndex: 5000,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: 'var(--chat-menu-shadow)',
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
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
                />
              </div>
              <div ref={listRef} style={{ maxHeight: 260, overflowY: 'auto' }}>
                {filtered.length === 0 && <div style={{ padding: 10, color: 'var(--muted)' }}>Нет совпадений</div>}
                {filtered.map((o) => {
                  const checked = safeValues.includes(o.id);
                  return (
                    <label
                      key={o.id}
                      style={{
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                      }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggle(o.id)} />
                      <span style={{ color: 'var(--text)' }}>{o.label}</span>
                    </label>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
