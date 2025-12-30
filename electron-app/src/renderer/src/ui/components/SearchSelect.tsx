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
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div
          onClick={() => {
            if (disabled) return;
            setOpen((v) => !v);
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
          <span style={{ color: selected ? '#111827' : '#6b7280' }}>
            {selected ? selected.label : props.placeholder ?? '(не выбрано)'}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ color: '#6b7280' }}>{open ? '▲' : '▼'}</span>
        </div>

        {!disabled && (
          <button
            type="button"
            onClick={() => {
              props.onChange(null);
              setOpen(false);
              setQuery('');
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
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.length === 0 && <div style={{ padding: 12, color: '#6b7280' }}>Ничего не найдено</div>}
            {filtered.map((o) => {
              const active = props.value === o.id;
              return (
                <div
                  key={o.id}
                  onClick={() => {
                    props.onChange(o.id);
                    setOpen(false);
                    setQuery('');
                  }}
                  style={{
                    padding: '10px 12px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #f3f4f6',
                    background: active ? '#eef2ff' : '#fff',
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


