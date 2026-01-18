import React, { useEffect, useMemo, useRef, useState } from 'react';

export type MultiSearchSelectOption = { id: string; label: string };

export function MultiSearchSelect(props: {
  values: string[];
  options: MultiSearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  const disabled = props.disabled === true;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(() => {
    const set = new Set(props.values);
    return props.options.filter((o) => set.has(o.id));
  }, [props.options, props.values]);

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
      if (e.target && el.contains(e.target as any)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function toggle(id: string) {
    const set = new Set(props.values);
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
              placeholder="Поиск..."
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 10,
                border: '1px solid var(--input-border)',
                background: 'var(--input-bg)',
                color: 'var(--text)',
              }}
            />
          </div>
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: 10, color: 'var(--muted)' }}>Нет совпадений</div>}
            {filtered.map((o) => {
              const checked = props.values.includes(o.id);
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
        </div>
      )}
    </div>
  );
}
