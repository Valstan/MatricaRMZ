import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSuggestionDropdown } from '../hooks/useSuggestionDropdown.js';
import { buildLookupHighlightParts } from '../utils/searchMatching.js';

export type MultiSearchSelectOption = { id: string; label: string; hintText?: string; searchText?: string };

export function MultiSearchSelect(props: {
  values: string[];
  options: MultiSearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  query?: string;
  onQueryChange?: (next: string) => void;
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
    if (props.query === undefined) return;
    if (dropdown.query === props.query) return;
    dropdown.setQuery(props.query);
  }, [dropdown.query, props.query]);

  useEffect(() => {
    if (!dropdown.open) return;
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [dropdown.open]);

  useEffect(() => {
    if (!dropdown.open) return;
    if (!dropdown.filtered.length) return;
    dropdown.setActiveIdx((i) => Math.min(Math.max(0, i), dropdown.filtered.length - 1));
  }, [dropdown.filtered.length, dropdown.open, dropdown.setActiveIdx]);

  function setQuery(next: string) {
    dropdown.setQuery(next);
    props.onQueryChange?.(next);
  }

  function toggle(id: string) {
    const set = new Set(safeValues);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    props.onChange(Array.from(set));
  }

  function clearAll() {
    props.onChange([]);
    dropdown.closeDropdown();
    setQuery('');
  }

  function selectAllFiltered() {
    const ids = dropdown.filtered.map((o) => o.id);
    const combined = new Set([...safeValues, ...ids]);
    props.onChange(Array.from(combined));
  }

  return (
    <div ref={dropdown.rootRef} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={searchInputRef}
          data-input-assist="component-suggestions"
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
            setQuery(e.target.value);
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
              dropdown.setActiveIdx((prev) => (prev < 0 ? 0 : Math.min(dropdown.filtered.length - 1, prev + 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (!dropdown.open) {
                dropdown.setOpen(true);
                return;
              }
              if (!dropdown.filtered.length) return;
              dropdown.setActiveIdx((prev) => (prev <= 0 ? 0 : prev - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (!dropdown.open) {
                dropdown.setOpen(true);
                return;
              }
              const option = dropdown.filtered[dropdown.activeIdx];
              if (!option) return;
              toggle(option.id);
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
                ...(dropdown.popupRect.placement === 'above'
                  ? { bottom: dropdown.popupRect.bottom }
                  : { top: dropdown.popupRect.top }),
                width: dropdown.popupRect.width,
                zIndex: 5000,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: 'var(--chat-menu-shadow)',
                overflow: 'hidden',
              }}
            >
              <div ref={dropdown.listRef} style={{ maxHeight: dropdown.popupRect.maxHeight - 42, overflowY: 'auto' }}>
                {dropdown.filtered.length === 0 && <div style={{ padding: 10, color: 'var(--muted)' }}>Нет совпадений</div>}
                {dropdown.filtered.map((o, idx) => {
                  const checked = safeValues.includes(o.id);
                  const focused = dropdown.activeIdx === idx;
                  const highlightParts = buildLookupHighlightParts(o.label, dropdown.query);
                  const hintParts = o.hintText ? buildLookupHighlightParts(o.hintText, dropdown.query) : null;
                  return (
                    <label
                      key={o.id}
                      data-idx={idx}
                      onMouseEnter={() => {
                        dropdown.setActiveIdx(idx);
                      }}
                      style={{
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                        padding: '8px 10px',
                        borderBottom: '1px solid var(--border)',
                        cursor: 'pointer',
                        background: focused ? 'rgba(96, 165, 250, 0.14)' : 'transparent',
                      }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggle(o.id)} />
                      <span style={{ display: 'grid', gap: 2, color: 'var(--text)', minWidth: 'min-content' }}>
                        <span style={{ whiteSpace: 'nowrap' }}>
                          {highlightParts.map((part, partIdx) => (
                            <span
                              key={`${o.id}-part-${partIdx}`}
                              style={part.matched ? { background: 'rgba(250, 204, 21, 0.28)', borderRadius: 3 } : undefined}
                            >
                              {part.text}
                            </span>
                          ))}
                        </span>
                        {hintParts && hintParts.some((part) => part.text) ? (
                          <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                            {hintParts.map((part, partIdx) => (
                              <span
                                key={`${o.id}-hint-${partIdx}`}
                                style={part.matched ? { background: 'rgba(250, 204, 21, 0.2)', borderRadius: 3 } : undefined}
                              >
                                {part.text}
                              </span>
                            ))}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
              {dropdown.filtered.length > 0 && (
                <div
                  style={{
                    padding: '6px 10px',
                    borderTop: '1px solid var(--border)',
                    background: 'var(--surface)',
                  }}
                >
                  <button
                    type="button"
                    onClick={selectAllFiltered}
                    style={{
                      width: '100%',
                      padding: '5px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--button-ghost-border)',
                      background: 'var(--button-ghost-bg)',
                      cursor: 'pointer',
                      color: 'var(--text)',
                      fontSize: 12,
                    }}
                  >
                    Выбрать всё
                  </button>
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
