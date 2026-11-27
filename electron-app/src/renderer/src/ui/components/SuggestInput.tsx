import React, { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import {
  ComponentSuggestionsHintButton,
  ComponentSuggestionsPopupHeader,
  useComponentSuggestionSuppress,
} from './componentSuggestionHints.js';
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
  /** Enter в поле, когда подсказка не выбрана (выпадашка закрыта или пуста). */
  onSubmit?: () => void;
  /**
   * Ждать подсказок: выпадашка открывается только когда есть что показать.
   *
   * Для поля, где подсказки приезжают из базы с задержкой (например, номер
   * двигателя по последним цифрам): пустой список «Нет совпадений» только мешал
   * бы вводу — слова оператор ищет по содержимому файлов, а подсказок по номеру
   * для слова нет. Список пришёл — выпадашка открывается сама.
   */
  waitForOptions?: boolean;
  /**
   * Сколько строк показывать в списке.
   *
   * Исторический потолок компонента — 15: список читают глазами, длиннее
   * выпадашка не нужна. Места, где подсказок бывает много (номер двигателя с
   * кнопкой «показать ещё»), поднимают потолок явно.
   */
  previewLimit?: number;
  /**
   * Подвал выпадашки: «показать ещё» (кнопка) или заметка (без `onClick`).
   *
   * Необязательный: поведение по умолчанию прежнее — подвала нет.
   */
  footer?: { label: string; onClick?: () => void };
  style?: React.CSSProperties;
  // Auto-close the dropdown after this many ms without interaction
  // (typing, arrow keys, hover/scroll over the list). Typing reopens it.
  // Default lives in useSuggestionDropdown (3s everywhere — owner's decision).
  autoHideMs?: number;
}) {
  const disabled = props.disabled === true;
  const previewLimit = Math.max(1, Math.trunc(Number(props.previewLimit ?? 15)) || 15);
  // Локальная копия: сужение `props.footer` теряется внутри обработчика клика.
  const footer = props.footer;
  const hints = useComponentSuggestionSuppress();
  const waitForOptions = props.waitForOptions === true;

  const dropdown = useSuggestionDropdown(
    props.options.map((o) =>
      o.description != null && o.description !== ''
        ? { id: o.value, label: o.value, hintText: o.description }
        : { id: o.value, label: o.value },
    ),
    props.autoHideMs !== undefined ? { autoHideMs: props.autoHideMs } : undefined,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [createBusy, setCreateBusy] = React.useState(false);
  const bumpAutoHide = dropdown.bumpAutoHide;
  // Hoisted so the effects below can depend on the setters themselves instead of the
  // whole `dropdown` object (which is a fresh object on every render). Both are raw
  // useState setters from useSuggestionDropdown, so they are referentially stable.
  const setDropdownQuery = dropdown.setQuery;
  const setDropdownActiveIdx = dropdown.setActiveIdx;
  const setDropdownOpen = dropdown.setOpen;
  const dropdownFiltered = dropdown.filtered;
  const dropdownOpen = dropdown.open;

  const openDropdown = useCallback(() => {
    if (disabled || hints.suppressed) return;
    // «Ждать подсказок»: пустой список не показываем.
    if (waitForOptions && dropdownFiltered.length === 0) return;
    dropdown.setOpen(true);
  }, [disabled, dropdown, dropdownFiltered.length, hints.suppressed, waitForOptions]);

  const hideSuggestions = useCallback(() => {
    hints.suppress();
    dropdown.closeDropdown();
    inputRef.current?.focus();
  }, [dropdown, hints]);

  useEffect(() => {
    setDropdownQuery(props.value ?? '');
  }, [props.value, setDropdownQuery]);

  useEffect(() => {
    if (!dropdown.open) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // No select-all here: this is a free-text field whose value tracks the query, so
    // selecting on every (re)open — including the inactivity auto-hide → keystroke
    // re-open — caused the next character to wipe the text down to one char.
  }, [dropdown.open]);

  useEffect(() => {
    if (!dropdown.open) return;
    if (!dropdown.filtered.length) return;
    setDropdownActiveIdx((i) => Math.min(Math.max(0, i), dropdown.filtered.length - 1));
  }, [dropdown.filtered.length, dropdown.open, setDropdownActiveIdx]);

  /**
   * Асинхронные подсказки: список пришёл после ввода — показываем его сразу.
   *
   * Показываем именно НОВЫЙ список (по числу подсказок): закрытый оператором
   * список (Escape, автоскрытие) сам собой не открывается снова.
   */
  const shownOptionsCountRef = useRef(0);
  useEffect(() => {
    if (!waitForOptions) return;
    const count = dropdownFiltered.length;
    if (count === 0) {
      shownOptionsCountRef.current = 0;
      return;
    }
    if (count <= shownOptionsCountRef.current) return;
    shownOptionsCountRef.current = count;
    if (dropdownOpen) return;
    if (document.activeElement !== inputRef.current) return;
    setDropdownOpen(true);
  }, [waitForOptions, dropdownFiltered.length, dropdownOpen, setDropdownOpen]);

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
        data-input-assist="component-suggestions"
        value={props.value}
        placeholder={props.placeholder}
        disabled={disabled}
        onFocus={() => {
          if (disabled) return;
          props.onFocus?.();
          hints.onFocus(openDropdown);
        }}
        onClick={() => {
          if (disabled) return;
          if (hints.suppressed) {
            hints.setHintVisible(true);
            return;
          }
          openDropdown();
        }}
        onBlur={() => {
          hints.onBlur();
          props.onBlur?.();
        }}
        onChange={(e) => {
          const v = e.target.value;
          props.onChange(v);
          dropdown.setQuery(v);
          if (!dropdown.open && hints.shouldOpenDropdown()) openDropdown();
          bumpAutoHide();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') bumpAutoHide();
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
              openDropdown();
              return;
            }
            if (!dropdown.filtered.length) return;
            dropdown.setActiveByKeyboard((p) => (p < 0 ? 0 : Math.min(dropdown.filtered.length - 1, p + 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (!dropdown.open) {
              openDropdown();
              return;
            }
            if (!dropdown.filtered.length) return;
            dropdown.setActiveByKeyboard((p) => (p <= 0 ? 0 : p - 1));
          } else if (e.key === 'Enter') {
            if (!dropdown.open) {
              // Выпадашки нет — значит подсказку выбирать нечего: Enter запускает поиск.
              props.onSubmit?.();
              return;
            }
            e.preventDefault();
            if (dropdown.activeIdx >= 0) {
              const active = dropdown.filtered[dropdown.activeIdx];
              if (active) pick(active.id);
            } else if (props.onCreate && dropdown.query.trim()) {
              void submitCreate();
            } else {
              props.onSubmit?.();
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
      <ComponentSuggestionsHintButton
        anchor={inputRef.current}
        visible={!disabled && hints.hintVisible && !dropdown.open}
        onShow={() => {
          hints.restore();
          dropdown.setOpen(true);
          inputRef.current?.focus();
        }}
      />

      {dropdown.open && !disabled && dropdown.popupRect && !(waitForOptions && dropdown.filtered.length === 0)
        ? createPortal(
            <div
              ref={dropdown.popupRef}
              onMouseDown={(e) => e.stopPropagation()}
              onMouseMove={bumpAutoHide}
              onWheel={bumpAutoHide}
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
              <ComponentSuggestionsPopupHeader onHide={hideSuggestions} />
              <div ref={dropdown.listRef} style={{ maxHeight: dropdown.popupRect.maxHeight - 32, overflowY: 'auto' }}>
                {dropdown.filtered.length === 0 && <div style={{ padding: 10, color: 'var(--muted)' }}>Нет совпадений</div>}
                {dropdown.filtered.slice(0, previewLimit).map((o, idx) => {
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
                      <div style={{ fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap' }}>{highlightMatch(o.label, dropdown.query)}</div>
                      {meta?.description ? (
                        <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>{meta.description}</div>
                      ) : null}
                    </div>
                  );
                })}
                {footer ? (
                  <div style={{ borderTop: '1px dashed var(--border)', padding: '8px 12px' }}>
                    {footer.onClick ? (
                      <button
                        type="button"
                        onClick={() => {
                          // Клик по подвалу — это взаимодействие: продлеваем
                          // жизнь выпадашки. Иначе автоскрытие (3 с) гасит её
                          // раньше, чем оператор увидит догруженный список.
                          bumpAutoHide();
                          footer.onClick?.();
                        }}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 8px',
                          borderRadius: 8,
                          border: '1px solid var(--input-border)',
                          background: 'var(--input-bg)',
                          color: 'var(--text)',
                          cursor: 'pointer',
                        }}
                      >
                        {footer.label}
                      </button>
                    ) : (
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{footer.label}</div>
                    )}
                  </div>
                ) : null}
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

