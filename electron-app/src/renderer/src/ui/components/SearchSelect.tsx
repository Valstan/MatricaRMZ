import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSuggestionDropdown } from '../hooks/useSuggestionDropdown.js';

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
  const dropdown = useSuggestionDropdown(props.options);
  const [createBusy, setCreateBusy] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => {
    if (!props.value) return null;
    return props.options.find((o) => o.id === props.value) ?? null;
  }, [props.options, props.value]);

  function close() {
    dropdown.closeDropdown();
    dropdown.setQuery(selected?.label ?? '');
    setCreateBusy(false);
  }

  function pickByIndex(idx: number) {
    const o = dropdown.filtered[idx];
    if (!o) return;
    props.onChange(o.id);
    dropdown.setQuery(o.label);
    close();
  }

  useEffect(() => {
    if (!dropdown.open) return;
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
  }, [dropdown.open]);

  useEffect(() => {
    if (dropdown.open) {
      dropdown.setQuery('');
      return;
    }
    dropdown.setQuery(selected?.label ?? '');
  }, [dropdown.open, selected?.label]);

  async function submitCreate() {
    if (!props.onCreate || createBusy) return;
    const label = dropdown.query.trim();
    if (!label) return;
    setCreateBusy(true);
    const id = await props.onCreate(label).catch(() => null);
    setCreateBusy(false);
    if (!id) return;
    props.onChange(id);
    dropdown.setQuery(label);
    close();
  }

  return (
    <div ref={dropdown.rootRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={searchInputRef}
          value={dropdown.query}
          placeholder={props.placeholder ?? '(не выбрано)'}
          disabled={disabled}
          onFocus={() => {
            if (disabled) return;
            dropdown.setOpen(true);
          }}
          onClick={() => {
            if (disabled) return;
            dropdown.setOpen(true);
          }}
          onChange={(e) => {
            if (disabled) return;
            if (!dropdown.open) dropdown.setOpen(true);
            dropdown.setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (disabled) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (!dropdown.open) {
                dropdown.setOpen(true);
                return;
              }
              if (!dropdown.filtered.length) return;
              dropdown.setActiveIdx((p) => (p < 0 ? 0 : Math.min(dropdown.filtered.length - 1, p + 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (!dropdown.open) {
                dropdown.setOpen(true);
                return;
              }
              if (!dropdown.filtered.length) return;
              dropdown.setActiveIdx((p) => (p <= 0 ? 0 : p - 1));
            } else if (e.key === 'Enter') {
              if (!dropdown.open) return;
              e.preventDefault();
              if (dropdown.activeIdx >= 0) pickByIndex(dropdown.activeIdx);
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
            color: 'var(--text)',
            minHeight: 36,
            outline: 'none',
          }}
          title={selected?.id ?? ''}
        />

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

      {dropdown.open && !disabled && dropdown.popupRect
        ? createPortal(
            <div
              ref={dropdown.popupRef}
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: dropdown.popupRect.left,
                top: dropdown.popupRect.top,
                width: dropdown.popupRect.width,
                zIndex: 5000,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: 'var(--chat-menu-shadow)',
                overflow: 'hidden',
              }}
            >
              <div ref={dropdown.listRef} style={{ maxHeight: 280, overflowY: 'auto' }}>
                {dropdown.filtered.length === 0 && <div style={{ padding: 12, color: 'var(--muted)' }}>Ничего не найдено</div>}
                {dropdown.filtered.map((o, idx) => {
                  const active = props.value === o.id;
                  const focused = dropdown.activeIdx === idx;
                  return (
                    <div
                      key={o.id}
                      data-idx={idx}
                      onClick={() => {
                        props.onChange(o.id);
                        close();
                      }}
                      onMouseEnter={() => {
                        dropdown.setActiveIdx(idx);
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
                  <div style={{ borderTop: '1px dashed var(--border)', padding: '10px 12px' }}>
                    <button
                      type="button"
                      onClick={() => void submitCreate()}
                      disabled={createBusy || !dropdown.query.trim()}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 10px',
                        borderRadius: 8,
                        border: '1px solid var(--input-border)',
                        background: 'var(--input-bg)',
                        color: 'var(--text)',
                        cursor: createBusy ? 'default' : 'pointer',
                      }}
                    >
                      {createBusy ? 'Создание…' : '+Создать и Вставить'}
                    </button>
                    {props.createLabel && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>{props.createLabel}</div>}
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


