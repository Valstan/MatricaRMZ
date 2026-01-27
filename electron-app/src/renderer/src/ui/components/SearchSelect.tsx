import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const [isCreating, setIsCreating] = useState(false);
  const [createValue, setCreateValue] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [popupRect, setPopupRect] = useState<{ left: number; top: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);

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
      const target = e.target as Node | null;
      if (target && (el.contains(target) || popupRef.current?.contains(target))) return;
      setOpen(false);
      setQuery('');
      setActiveIdx(-1);
      setIsCreating(false);
      setCreateValue('');
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

  function close() {
    setOpen(false);
    setQuery('');
    setActiveIdx(-1);
    setIsCreating(false);
    setCreateValue('');
    setCreateBusy(false);
    setPopupRect(null);
  }

  function openOrToggle() {
    if (disabled) return;
    setOpen((v) => {
      const next = !v;
      if (!next) {
        setQuery('');
        setActiveIdx(-1);
        setIsCreating(false);
        setCreateValue('');
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

  useEffect(() => {
    if (!open || !isCreating) return;
    const input = createInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [open, isCreating]);

  function startCreate() {
    if (disabled || !props.onCreate) return;
    setIsCreating(true);
    setCreateBusy(false);
    setCreateValue(query.trim());
    setActiveIdx(-1);
  }

  async function submitCreate() {
    if (!props.onCreate || createBusy) return;
    const label = createValue.trim();
    if (!label) return;
    setCreateBusy(true);
    const id = await props.onCreate(label).catch(() => null);
    setCreateBusy(false);
    if (!id) return;
    props.onChange(id);
    close();
  }

  function cancelCreate() {
    setIsCreating(false);
    setCreateValue('');
    setCreateBusy(false);
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

      {open && !disabled && popupRect
        ? createPortal(
            <div
              ref={popupRef}
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
                      <div
                        style={{
                          marginTop: 2,
                          fontSize: 12,
                          color: 'var(--muted)',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        }}
                      >
                        {o.id.slice(0, 8)}
                      </div>
                    </div>
                  );
                })}
                {props.onCreate && (
                  <div style={{ borderTop: '1px dashed var(--border)' }}>
                    {isCreating ? (
                      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <input
                          ref={createInputRef}
                          value={createValue}
                          onChange={(e) => setCreateValue(e.target.value)}
                          placeholder={props.createLabel ?? 'Добавить'}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void submitCreate();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              cancelCreate();
                            }
                          }}
                          style={{
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid var(--input-border)',
                            background: 'var(--input-bg)',
                            color: 'var(--text)',
                            outline: 'none',
                          }}
                          disabled={createBusy}
                        />
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            type="button"
                            onClick={() => void submitCreate()}
                            disabled={createBusy || !createValue.trim()}
                            style={{
                              padding: '6px 10px',
                              borderRadius: 8,
                              border: '1px solid var(--input-border)',
                              background: 'var(--input-bg)',
                              color: 'var(--text)',
                              cursor: createBusy ? 'default' : 'pointer',
                            }}
                          >
                            {createBusy ? 'Добавляем…' : 'Добавить'}
                          </button>
                          <button
                            type="button"
                            onClick={cancelCreate}
                            disabled={createBusy}
                            style={{
                              padding: '6px 10px',
                              borderRadius: 8,
                              border: '1px solid var(--border)',
                              background: 'transparent',
                              color: 'var(--muted)',
                              cursor: createBusy ? 'default' : 'pointer',
                            }}
                          >
                            Отмена
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        onClick={startCreate}
                        style={{
                          padding: '10px 12px',
                          cursor: 'pointer',
                          background: 'transparent',
                        }}
                      >
                        <div style={{ fontWeight: 700, color: 'var(--text)' }}>+ Добавить</div>
                        {props.createLabel && <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)' }}>{props.createLabel}</div>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}


