import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useSuggestionDropdown } from '../hooks/useSuggestionDropdown.js';

export type SuggestInputOption = {
  value: string;
  description?: string;
};

function highlightMatch(text: string, query: string) {
  const src = String(text ?? '');
  const q = String(query ?? '').trim();
  if (!q) return src;
  const lowerSrc = src.toLowerCase();
  const lowerQ = q.toLowerCase();
  const idx = lowerSrc.indexOf(lowerQ);
  if (idx < 0) return src;
  const before = src.slice(0, idx);
  const match = src.slice(idx, idx + q.length);
  const after = src.slice(idx + q.length);
  return (
    <>
      {before}
      <mark
        style={{
          background: 'rgba(250, 204, 21, 0.32)',
          color: 'inherit',
          borderRadius: 4,
          padding: '0 2px',
        }}
      >
        {match}
      </mark>
      {after}
    </>
  );
}

export function SuggestInput(props: {
  value: string;
  options: SuggestInputOption[];
  placeholder?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
  onCreate?: (label: string) => Promise<string | null>;
  onBlur?: () => void;
  onFocus?: () => void;
  style?: React.CSSProperties;
}) {
  const disabled = props.disabled === true;
  const dropdown = useSuggestionDropdown(props.options.map((o) => ({ id: o.value, label: o.value })));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [createBusy, setCreateBusy] = React.useState(false);

  useEffect(() => {
    dropdown.setQuery(props.value ?? '');
  }, [props.value]);

  useEffect(() => {
    if (!dropdown.open) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
  }, [dropdown.open]);

  function pick(value: string) {
    props.onChange(value);
    dropdown.setQuery(value);
    dropdown.closeDropdown();
  }

  async function submitCreate() {
    if (!props.onCreate || createBusy) return;
    const label = dropdown.query.trim();
    if (!label) return;
    setCreateBusy(true);
    const created = await props.onCreate(label).catch(() => null);
    setCreateBusy(false);
    if (!created) return;
    pick(created);
  }

  return (
    <div ref={dropdown.rootRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
      <input
        ref={inputRef}
        value={props.value}
        placeholder={props.placeholder}
        disabled={disabled}
        onFocus={() => {
          if (disabled) return;
          props.onFocus?.();
          dropdown.setOpen(true);
        }}
        onClick={() => {
          if (disabled) return;
          dropdown.setOpen(true);
        }}
        onBlur={() => props.onBlur?.()}
        onChange={(e) => {
          const v = e.target.value;
          props.onChange(v);
          dropdown.setQuery(v);
          if (!dropdown.open) dropdown.setOpen(true);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.ctrlKey && e.key === 'Enter') {
            if (props.onCreate && dropdown.query.trim()) {
              e.preventDefault();
              void submitCreate();
            }
            return;
          }
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
            if (dropdown.activeIdx >= 0) {
              const active = dropdown.filtered[dropdown.activeIdx];
              if (active) pick(active.id);
            } else if (props.onCreate && dropdown.query.trim()) {
              void submitCreate();
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            dropdown.closeDropdown();
          }
        }}
        style={{
          width: '100%',
          minWidth: 0,
          padding: '7px 10px',
          border: '1px solid var(--input-border)',
          outline: 'none',
          background: disabled ? 'var(--input-bg-disabled)' : 'var(--input-bg)',
          color: 'var(--text)',
          fontSize: 14,
          lineHeight: 1.2,
          minHeight: 32,
          boxShadow: 'var(--input-shadow)',
          ...(props.style ?? {}),
        }}
      />
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
                {dropdown.filtered.map((o, idx) => {
                  const focused = dropdown.activeIdx === idx;
                  const meta = props.options.find((x) => x.value === o.id);
                  return (
                    <div
                      key={`${o.id}_${idx}`}
                      data-idx={idx}
                      onClick={() => pick(o.id)}
                      onMouseEnter={() => dropdown.setActiveIdx(idx)}
                      style={{
                        padding: '10px 12px',
                        cursor: 'pointer',
                        borderBottom: '1px solid var(--border)',
                        background: focused ? 'rgba(96, 165, 250, 0.18)' : 'transparent',
                      }}
                    >
                      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{highlightMatch(o.label, dropdown.query)}</div>
                      {meta?.description ? <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)' }}>{meta.description}</div> : null}
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
                      {createBusy ? 'Создание…' : '+Создать и Вставить (Ctrl+Enter)'}
                    </button>
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

