import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSuggestionDropdown } from '../hooks/useSuggestionDropdown.js';
import { buildLookupHighlightParts, normalizeLookupText, rankLookupOptions } from '../utils/searchMatching.js';

export type SearchSelectOption = { id: string; label: string; hintText?: string; searchText?: string };

function formatCreateError(error: unknown): string {
  const raw = String(error ?? '').trim();
  if (!raw) return 'Не удалось создать элемент';
  return raw.replace(/^Error:\s*/i, '').trim() || 'Не удалось создать элемент';
}

export function SearchSelect(props: {
  value: string | null;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  query?: string;
  onQueryChange?: (next: string) => void;
  onChange: (next: string | null) => void;
  onCreate?: (label: string) => Promise<string | null>;
  createLabel?: string;
}) {
  const disabled = props.disabled === true;
  const dropdown = useSuggestionDropdown(props.options);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const selected = useMemo(() => {
    if (!props.value) return null;
    return props.options.find((o) => o.id === props.value) ?? null;
  }, [props.options, props.value]);
  const normalizedQuery = useMemo(() => normalizeLookupText(dropdown.query), [dropdown.query]);
  const similarMatches = useMemo(() => {
    if (!normalizedQuery) return [];
    return rankLookupOptions(props.options, normalizedQuery).slice(0, 5);
  }, [normalizedQuery, props.options]);
  const exactMatch = useMemo(
    () => props.options.find((option) => normalizeLookupText(option.label) === normalizedQuery) ?? null,
    [normalizedQuery, props.options],
  );

  function setQuery(next: string) {
    dropdown.setQuery(next);
    props.onQueryChange?.(next);
  }

  function close(nextLabel?: string) {
    dropdown.closeDropdown();
    dropdown.setQuery(nextLabel ?? selected?.label ?? '');
    setCreateBusy(false);
    setCreateError('');
  }

  function pickByIndex(idx: number) {
    const o = dropdown.filtered[idx];
    if (!o) return;
    props.onChange(o.id);
    close(o.label);
  }

  useEffect(() => {
    if (!dropdown.open) return;
    const input = searchInputRef.current;
    if (!input) return;
    input.focus();
    if (input.value.trim()) input.select();
  }, [dropdown.open]);

  useEffect(() => {
    if (!dropdown.open) {
      const next = selected?.label ?? '';
      if (dropdown.query !== next) dropdown.setQuery(next);
      return;
    }
    const next =
      props.query !== undefined ? props.query : String(dropdown.query ?? '').trim() ? dropdown.query : (selected?.label ?? '');
    if (dropdown.query !== next) dropdown.setQuery(next);
  }, [dropdown.open, dropdown.query, props.query, selected?.label]);

  async function submitCreate() {
    if (!props.onCreate || createBusy) return;
    const label = dropdown.query.trim();
    if (!label) return;
    if (exactMatch) {
      setCreateError(`Похожий элемент уже существует: ${exactMatch.label}`);
      return;
    }
    setCreateBusy(true);
    setCreateError('');
    let id: string | null = null;
    let errorText = '';
    try {
      id = await props.onCreate(label);
    } catch (error) {
      errorText = formatCreateError(error);
    }
    setCreateBusy(false);
    if (!id) {
      setCreateError(errorText || 'Не удалось создать элемент');
      return;
    }
    props.onChange(id);
    close(label);
  }

  return (
    <div ref={dropdown.rootRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', minWidth: 0 }}>
        <input
          ref={searchInputRef}
          data-input-assist="component-suggestions"
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
              if (e.ctrlKey && props.onCreate && dropdown.query.trim()) {
                void submitCreate();
              } else if (dropdown.activeIdx >= 0) {
                pickByIndex(dropdown.activeIdx);
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
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
              props.onQueryChange?.('');
              close('');
            }}
            style={{
              flexShrink: 0,
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
              <div ref={dropdown.listRef} style={{ maxHeight: dropdown.popupRect.maxHeight, overflowY: 'auto' }}>
                {dropdown.filtered.length === 0 && <div style={{ padding: 12, color: 'var(--muted)' }}>Ничего не найдено</div>}
                {dropdown.filtered.map((o, idx) => {
                  const active = props.value === o.id;
                  const focused = dropdown.activeIdx === idx;
                  const highlightParts = buildLookupHighlightParts(o.label, dropdown.query);
                  const hintParts = o.hintText ? buildLookupHighlightParts(o.hintText, dropdown.query) : null;
                  return (
                    <div
                      key={o.id}
                      data-idx={idx}
                      onClick={() => {
                        props.onChange(o.id);
                        close(o.label);
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
                      <div style={{ fontWeight: 700, color: 'var(--text)' }}>
                        {highlightParts.map((part, partIdx) => (
                          <span
                            key={`${o.id}-part-${partIdx}`}
                            style={part.matched ? { background: 'rgba(250, 204, 21, 0.28)', borderRadius: 3 } : undefined}
                          >
                            {part.text}
                          </span>
                        ))}
                      </div>
                      {hintParts && hintParts.some((part) => part.text) ? (
                        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)' }}>
                          {hintParts.map((part, partIdx) => (
                            <span
                              key={`${o.id}-hint-${partIdx}`}
                              style={part.matched ? { background: 'rgba(250, 204, 21, 0.2)', borderRadius: 3 } : undefined}
                            >
                              {part.text}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {props.onCreate && (
                  <div style={{ borderTop: '1px dashed var(--border)', padding: '10px 12px' }}>
                    <button
                      type="button"
                      onClick={() => void submitCreate()}
                      disabled={createBusy || !dropdown.query.trim() || !!exactMatch}
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
                      {createBusy ? 'Создание…' : '+Создать и Вставить (Ctrl+Enter)'}
                    </button>
                    {exactMatch ? (
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--warning, #b45309)' }}>
                        Похожий элемент уже найден: {exactMatch.label}
                      </div>
                    ) : null}
                    {!exactMatch && similarMatches.length > 0 ? (
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                        Похожие варианты: {similarMatches.map((option) => option.label).join(' • ')}
                      </div>
                    ) : null}
                    {createError ? <div style={{ marginTop: 6, fontSize: 12, color: 'var(--danger)' }}>{createError}</div> : null}
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


