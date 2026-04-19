import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSuggestionDropdown } from '../hooks/useSuggestionDropdown.js';
import { buildLookupHighlightParts, normalizeLookupText, rankLookupOptions } from '../utils/searchMatching.js';

export type SearchSelectOption = { id: string; label: string; hintText?: string; searchText?: string };

type SourceLabel = 'database' | 'current' | 'autocomplete';

function formatCreateError(error: unknown): string {
  const raw = String(error ?? '').trim();
  if (!raw) return 'Не удалось создать элемент';
  return raw.replace(/^Error:\s*/i, '').trim() || 'Не удалось создать элемент';
}

function sourceBadge(label: SourceLabel): React.ReactNode {
  const styles: Record<SourceLabel, React.CSSProperties> = {
    database: { fontSize: 10, color: '#6b7280', background: '#f3f4f6', padding: '1px 5px', borderRadius: 4 },
    current: { fontSize: 10, color: '#2563eb', background: '#dbeafe', padding: '1px 5px', borderRadius: 4 },
    autocomplete: { fontSize: 10, color: '#059669', background: '#d1fae5', padding: '1px 5px', borderRadius: 4 },
  };
  const text: Record<SourceLabel, string> = {
    database: 'БД',
    current: 'Текущее',
    autocomplete: 'Авто',
  };
  return <span style={styles[label]}>{text[label]}</span>;
}

/** Сколько подсказок участвует в ранжировании (данные из переданного массива options). */
const MAX_RANKED_OPTIONS = 15;
/** Видимая высота списка — ~5 строк, остальное через прокрутку. */
const VISIBLE_ROWS_CAP = 5;
const ROW_APPROX_PX = 42;
const listViewportMaxPx = VISIBLE_ROWS_CAP * ROW_APPROX_PX;

export function SearchSelect(props: {
  value: string | null;
  options: SearchSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  showAllWhenEmpty?: boolean;
  emptyQueryLimit?: number;
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
    return rankLookupOptions(props.options, normalizedQuery).slice(0, MAX_RANKED_OPTIONS);
  }, [normalizedQuery, props.options]);

  const emptyQueryItems = useMemo(() => {
    if (normalizedQuery) return [];
    if (!props.showAllWhenEmpty) return [];
    const limit = Math.max(1, Math.min(500, Math.trunc(Number(props.emptyQueryLimit ?? 200))));
    return props.options.slice(0, limit).map((option) => ({ option, source: 'database' as SourceLabel }));
  }, [normalizedQuery, props.emptyQueryLimit, props.options, props.showAllWhenEmpty]);

  const exactMatch = useMemo(
    () => props.options.find((option) => normalizeLookupText(option.label) === normalizedQuery) ?? null,
    [normalizedQuery, props.options],
  );

  const visibleItems = useMemo(() => {
    if (!normalizedQuery) return emptyQueryItems;
    // Если есть exactMatch — показываем его первым
    if (exactMatch) {
      return [{ option: exactMatch, source: 'current' as SourceLabel }];
    }
    // Иначе — top ranked из БД
    return similarMatches.map((o) => ({ option: o, source: 'database' as SourceLabel }));
  }, [emptyQueryItems, exactMatch, normalizedQuery, similarMatches]);

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
    const item = visibleItems[idx];
    if (!item) return;
    props.onChange(item.option.id);
    close(item.option.label);
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

  useEffect(() => {
    if (!dropdown.open) return;
    dropdown.setActiveIdx((idx) => {
      if (visibleItems.length === 0) return -1;
      if (exactMatch) return 0;
      if (idx < 0) return 0;
      if (idx >= visibleItems.length) return visibleItems.length - 1;
      return idx;
    });
  }, [dropdown.open, dropdown.setActiveIdx, exactMatch, visibleItems.length]);

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

  // Обработка клавиш для видимых элементов
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!dropdown.open) { dropdown.setOpen(true); return; }
      if (visibleItems.length === 0) return;
      dropdown.setActiveIdx((p) => (p < 0 ? 0 : Math.min(visibleItems.length - 1, p + 1)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!dropdown.open) { dropdown.setOpen(true); return; }
      if (visibleItems.length === 0) return;
      dropdown.setActiveIdx((p) => (p <= 0 ? 0 : p - 1));
    } else if (e.key === 'Enter') {
      if (!dropdown.open) return;
      e.preventDefault();
      if (e.ctrlKey && props.onCreate && dropdown.query.trim()) {
        void submitCreate();
      } else if (dropdown.activeIdx >= 0 && dropdown.activeIdx < visibleItems.length) {
        pickByIndex(dropdown.activeIdx);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }, [disabled, dropdown, visibleItems, props.onCreate, exactMatch]);

  const createBtnHeight = props.onCreate ? 52 : 0;

  return (
    <div ref={dropdown.rootRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', minWidth: 0 }}>
        <input
          ref={searchInputRef}
          data-input-assist="component-suggestions"
          value={dropdown.query}
          placeholder={props.placeholder ?? '(не выбрано)'}
          disabled={disabled}
          onFocus={() => { if (disabled) return; dropdown.setOpen(true); }}
          onClick={() => { if (disabled) return; dropdown.setOpen(true); }}
          onChange={(e) => { if (disabled) return; if (!dropdown.open) dropdown.setOpen(true); setQuery(e.target.value); }}
          onKeyDown={handleKeyDown}
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
            onClick={() => { props.onChange(null); props.onQueryChange?.(''); close(''); }}
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
                ...(dropdown.popupRect.placement === 'above'
                  ? { bottom: dropdown.popupRect.bottom }
                  : { top: dropdown.popupRect.top }),
                width: dropdown.popupRect.width,
                maxHeight: dropdown.popupRect.maxHeight,
                height: Math.min(
                  createBtnHeight + Math.min(listViewportMaxPx, Math.max(ROW_APPROX_PX, dropdown.popupRect.maxHeight - createBtnHeight - 6)),
                  dropdown.popupRect.maxHeight,
                ),
                zIndex: 5000,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: 'var(--chat-menu-shadow)',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                ref={dropdown.listRef}
                style={{
                  flex: '1 1 auto',
                  minHeight: 0,
                  maxHeight: Math.min(listViewportMaxPx, Math.max(ROW_APPROX_PX, dropdown.popupRect.maxHeight - createBtnHeight - 6)),
                  overflowY: 'auto',
                }}
              >
                {visibleItems.length === 0 && !props.onCreate && (
                  <div style={{ padding: 12, color: 'var(--muted)' }}>Ничего не найдено</div>
                )}
                {visibleItems.map((item, idx) => {
                  const { option, source } = item;
                  const active = props.value === option.id;
                  const focused = dropdown.activeIdx === idx;
                  const highlightParts = buildLookupHighlightParts(option.label, dropdown.query);
                  const hintParts = option.hintText ? buildLookupHighlightParts(option.hintText, dropdown.query) : null;
                  return (
                    <div
                      key={option.id}
                      data-idx={idx}
                      onClick={() => { props.onChange(option.id); close(option.label); }}
                      onMouseEnter={() => dropdown.setActiveIdx(idx)}
                      style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        borderBottom: props.onCreate ? '1px solid var(--border)' : 'none',
                        background: focused ? 'rgba(96, 165, 250, 0.18)' : active ? 'rgba(129, 140, 248, 0.18)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minHeight: 38,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 'min-content' }}>
                        <div style={{ fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                          {highlightParts.map((part, partIdx) => (
                            <span
                              key={`${option.id}-part-${partIdx}`}
                              style={part.matched ? { background: 'rgba(250, 204, 21, 0.28)', borderRadius: 3 } : undefined}
                            >
                              {part.text}
                            </span>
                          ))}
                        </div>
                        {hintParts && hintParts.some((part) => part.text) ? (
                          <div style={{ marginTop: 1, fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                            {hintParts.map((part, partIdx) => (
                              <span
                                key={`${option.id}-hint-${partIdx}`}
                                style={part.matched ? { background: 'rgba(250, 204, 21, 0.2)', borderRadius: 3 } : undefined}
                              >
                                {part.text}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                      {sourceBadge(source)}
                    </div>
                  );
                })}
              </div>

              {/* Кнопка «+Создать и Вставить» — закреплена внизу попапа */}
              {props.onCreate && (
                <div style={{ borderTop: '1px dashed var(--border)', padding: '8px 10px', flexShrink: 0, background: 'var(--surface)' }}>
                  <button
                    type="button"
                    onClick={() => void submitCreate()}
                    disabled={createBusy || !dropdown.query.trim() || !!exactMatch}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '6px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--input-border)',
                      background: (!dropdown.query.trim() || exactMatch) ? 'var(--surface2)' : 'var(--input-bg)',
                      color: (!dropdown.query.trim() || exactMatch) ? 'var(--muted)' : 'var(--text)',
                      cursor: createBusy || !dropdown.query.trim() || exactMatch ? 'default' : 'pointer',
                      fontSize: 13,
                      fontWeight: 500,
                    }}
                  >
                    {createBusy ? 'Создание…' : !dropdown.query.trim() ? 'Введите название и нажмите Ctrl+Enter' : '+Создать и Вставить (Ctrl+Enter)'}
                  </button>
                  {exactMatch ? (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--warning, #b45309)' }}>
                      Такой элемент уже есть.{' '}
                      <button
                        type="button"
                        onClick={() => { props.onChange(exactMatch.id); close(exactMatch.label); }}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--accent, #2563eb)',
                          cursor: 'pointer',
                          padding: 0,
                          fontSize: 11,
                        }}
                      >
                        Выбрать: {exactMatch.label}
                      </button>
                    </div>
                  ) : null}
                  {!exactMatch && createError ? (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--danger)' }}>{createError}</div>
                  ) : null}
                  {props.createLabel && !exactMatch && !createError ? (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--muted)' }}>{props.createLabel}</div>
                  ) : null}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
