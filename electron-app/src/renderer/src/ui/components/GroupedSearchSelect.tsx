import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useSuggestionDropdown } from '../hooks/useSuggestionDropdown.js';
import { buildLookupHighlightParts, normalizeLookupText } from '../utils/searchMatching.js';

export type GroupedSearchSelectItem = {
  id: string;
  label: string;
  hintText?: string;
  /** Тип BOM-компонента у этого item'а (sleeve/piston/.../engine). Возвращается в onChange callback. */
  componentTypeId: string | null;
};

export type GroupedSearchSelectGroup = {
  groupId: string;
  groupLabel: string;
  items: GroupedSearchSelectItem[];
};

const ROW_APPROX_PX = 42;
const GROUP_HEADER_PX = 26;
const VISIBLE_ROWS_CAP = 6;
const listViewportMaxPx = VISIBLE_ROWS_CAP * ROW_APPROX_PX + GROUP_HEADER_PX * 2;

/**
 * Объединённый виджет «тип + компонент»: один select с группировкой по типу.
 * Выбор item'а атомарно сообщает оба значения (id + componentTypeId) — рассинхрон
 * componentType ↔ nomenclature.componentTypeId становится невозможен по построению.
 */
export function GroupedSearchSelect(props: {
  value: string | null;
  groups: GroupedSearchSelectGroup[];
  placeholder?: string;
  disabled?: boolean;
  /** При очистке возвращает (null, null). */
  onChange: (itemId: string | null, componentTypeId: string | null) => void;
}) {
  const disabled = props.disabled === true;

  const allItems = useMemo(() => {
    const list: Array<GroupedSearchSelectItem & { groupId: string; groupLabel: string }> = [];
    for (const group of props.groups) {
      for (const item of group.items) {
        list.push({ ...item, groupId: group.groupId, groupLabel: group.groupLabel });
      }
    }
    return list;
  }, [props.groups]);

  // useSuggestionDropdown отвечает за позиционирование и закрытие при клике вне,
  // плоский список нужен ему только для оценки ширины — ranking мы делаем сами.
  const dropdown = useSuggestionDropdown(allItems);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const selected = useMemo(() => {
    if (!props.value) return null;
    return allItems.find((item) => item.id === props.value) ?? null;
  }, [allItems, props.value]);

  const normalizedQuery = useMemo(() => normalizeLookupText(dropdown.query), [dropdown.query]);

  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return props.groups.filter((g) => g.items.length > 0);
    const result: GroupedSearchSelectGroup[] = [];
    for (const group of props.groups) {
      const filtered = group.items.filter((item) => {
        const haystack = normalizeLookupText(`${item.label} ${item.hintText ?? ''}`);
        return haystack.includes(normalizedQuery);
      });
      if (filtered.length > 0) result.push({ ...group, items: filtered });
    }
    return result;
  }, [normalizedQuery, props.groups]);

  const flatVisibleItems = useMemo(() => {
    const list: Array<GroupedSearchSelectItem & { groupId: string; groupLabel: string }> = [];
    for (const group of visibleGroups) {
      for (const item of group.items) list.push({ ...item, groupId: group.groupId, groupLabel: group.groupLabel });
    }
    return list;
  }, [visibleGroups]);

  const openDropdown = useCallback(() => {
    if (disabled) return;
    dropdown.setOpen(true);
  }, [disabled, dropdown]);

  const close = useCallback(
    (nextLabel?: string) => {
      dropdown.closeDropdown();
      dropdown.setQuery(nextLabel ?? selected?.label ?? '');
    },
    [dropdown, selected?.label],
  );

  const pickItem = useCallback(
    (item: GroupedSearchSelectItem) => {
      props.onChange(item.id, item.componentTypeId);
      close(item.label);
    },
    [close, props],
  );

  useEffect(() => {
    if (!dropdown.open) {
      // Keep typed text on inactivity auto-hide; revert to selected label only on
      // an explicit close (pick / click-away / Escape).
      if (dropdown.autoHidden) return;
      const next = selected?.label ?? '';
      if (dropdown.query !== next) dropdown.setQuery(next);
      return;
    }
    const input = searchInputRef.current;
    if (input) {
      input.focus();
      if (input.value.trim()) input.select();
    }
  }, [dropdown, dropdown.open, dropdown.autoHidden, selected?.label]);

  useEffect(() => {
    if (!dropdown.open) return;
    dropdown.setActiveIdx((idx) => {
      if (flatVisibleItems.length === 0) return -1;
      if (idx < 0) return 0;
      if (idx >= flatVisibleItems.length) return flatVisibleItems.length - 1;
      return idx;
    });
  }, [dropdown, dropdown.open, flatVisibleItems.length]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (disabled) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!dropdown.open) {
          openDropdown();
          return;
        }
        if (flatVisibleItems.length === 0) return;
        dropdown.setActiveByKeyboard((p) => (p < 0 ? 0 : Math.min(flatVisibleItems.length - 1, p + 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!dropdown.open) {
          openDropdown();
          return;
        }
        if (flatVisibleItems.length === 0) return;
        dropdown.setActiveByKeyboard((p) => (p <= 0 ? 0 : p - 1));
      } else if (e.key === 'Enter') {
        if (!dropdown.open) return;
        e.preventDefault();
        const idx = dropdown.activeIdx;
        if (idx >= 0 && idx < flatVisibleItems.length) {
          pickItem(flatVisibleItems[idx]!);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    },
    [close, disabled, dropdown, flatVisibleItems, openDropdown, pickItem],
  );

  let runningIdx = -1;

  return (
    <div ref={dropdown.rootRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%', minWidth: 0 }}>
        <input
          ref={searchInputRef}
          value={dropdown.query}
          placeholder={props.placeholder ?? '(не выбрано)'}
          disabled={disabled}
          onFocus={() => {
            if (disabled) return;
            openDropdown();
          }}
          onClick={() => {
            if (disabled) return;
            openDropdown();
          }}
          onChange={(e) => {
            if (disabled) return;
            if (!dropdown.open) openDropdown();
            dropdown.setQuery(e.target.value);
          }}
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
          title={selected?.label ?? ''}
        />
        {!disabled && (
          <button
            type="button"
            onClick={() => {
              props.onChange(null, null);
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
                ...(dropdown.popupRect.placement === 'above'
                  ? { bottom: dropdown.popupRect.bottom }
                  : { top: dropdown.popupRect.top }),
                width: dropdown.popupRect.width,
                maxHeight: dropdown.popupRect.maxHeight,
                height: Math.min(listViewportMaxPx, dropdown.popupRect.maxHeight),
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
                style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}
              >
                {visibleGroups.length === 0 ? (
                  <div style={{ padding: 12, color: 'var(--muted)' }}>Ничего не найдено</div>
                ) : (
                  visibleGroups.map((group) => (
                    <div key={group.groupId}>
                      <div
                        style={{
                          padding: '4px 12px',
                          fontSize: 11,
                          fontWeight: 700,
                          color: 'var(--muted)',
                          background: 'var(--surface2, rgba(148,163,184,0.08))',
                          textTransform: 'uppercase',
                          letterSpacing: 0.4,
                          position: 'sticky',
                          top: 0,
                        }}
                      >
                        {group.groupLabel}
                      </div>
                      {group.items.map((item) => {
                        runningIdx += 1;
                        const idx = runningIdx;
                        const active = props.value === item.id;
                        const focused = dropdown.activeIdx === idx || hovered === item.id;
                        const highlightParts = buildLookupHighlightParts(item.label, dropdown.query);
                        const hintParts = item.hintText
                          ? buildLookupHighlightParts(item.hintText, dropdown.query)
                          : null;
                        return (
                          <div
                            key={item.id}
                            data-idx={idx}
                            onClick={() => pickItem(item)}
                            onMouseEnter={() => {
                              setHovered(item.id);
                              dropdown.setActiveIdx(idx);
                            }}
                            onMouseLeave={() => setHovered(null)}
                            style={{
                              padding: '8px 12px',
                              cursor: 'pointer',
                              background: focused
                                ? 'rgba(96, 165, 250, 0.18)'
                                : active
                                  ? 'rgba(129, 140, 248, 0.18)'
                                  : 'transparent',
                              minHeight: 38,
                            }}
                          >
                            <div style={{ fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>
                              {highlightParts.map((part, partIdx) => (
                                <span
                                  key={`${item.id}-part-${partIdx}`}
                                  style={
                                    part.matched
                                      ? { background: 'rgba(250, 204, 21, 0.28)', borderRadius: 3 }
                                      : undefined
                                  }
                                >
                                  {part.text}
                                </span>
                              ))}
                            </div>
                            {hintParts && hintParts.some((part) => part.text) ? (
                              <div style={{ marginTop: 1, fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                                {hintParts.map((part, partIdx) => (
                                  <span
                                    key={`${item.id}-hint-${partIdx}`}
                                    style={
                                      part.matched
                                        ? { background: 'rgba(250, 204, 21, 0.2)', borderRadius: 3 }
                                        : undefined
                                    }
                                  >
                                    {part.text}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
