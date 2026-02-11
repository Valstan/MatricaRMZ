import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSuggestionDropdown } from '../hooks/useSuggestionDropdown.js';

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
  const dropdown = useSuggestionDropdown(props.options);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => {
    const set = new Set(safeValues);
    return props.options.filter((o) => set.has(o.id));
  }, [props.options, safeValues]);

  useEffect(() => {
    if (!dropdown.open) return;
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [dropdown.open]);

  function toggle(id: string) {
    const set = new Set(safeValues);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    props.onChange(Array.from(set));
  }

  function clearAll() {
    props.onChange([]);
    dropdown.closeDropdown();
    dropdown.setQuery('');
  }

  return (
    <div ref={dropdown.rootRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={searchInputRef}
          value={dropdown.query}
          placeholder={props.placeholder ?? (selected.length ? selected.map((s) => s.label).join(', ') : '(не выбрано)')}
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
              dropdown.setOpen(true);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              dropdown.setOpen(true);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              dropdown.closeDropdown();
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
          title={selected.map((s) => s.label).join(', ')}
        />

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
              <div ref={dropdown.listRef} style={{ maxHeight: 260, overflowY: 'auto' }}>
                {dropdown.filtered.length === 0 && <div style={{ padding: 10, color: 'var(--muted)' }}>Нет совпадений</div>}
                {dropdown.filtered.map((o) => {
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
