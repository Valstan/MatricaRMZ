import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

type ManagedField = HTMLInputElement | HTMLTextAreaElement;
type HistoryMap = Record<string, string[]>;
type PopupItem = {
  value: string;
  kind: 'current' | 'history';
};
type PopupRect = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};
type PopupState = PopupRect & {
  target: ManagedField;
  value: string;
  items: PopupItem[];
};

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);
const HISTORY_INPUT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel']);
const PICKER_INPUT_TYPES = new Set(['date', 'datetime-local', 'time', 'month', 'week']);
const MAX_HISTORY_PER_FIELD = 6;
const MAX_STORED_FIELDS = 160;
const MAX_STORED_VALUE_LENGTH = 240;

function readInputType(field: ManagedField): string {
  if (field instanceof HTMLTextAreaElement) return 'textarea';
  return String(field.type || 'text').toLowerCase();
}

function isManagedField(node: EventTarget | null): node is ManagedField {
  if (node instanceof HTMLTextAreaElement) {
    return !node.disabled && !node.readOnly;
  }
  if (node instanceof HTMLInputElement) {
    const type = readInputType(node);
    return !node.disabled && !node.readOnly && !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

function isSensitiveField(field: ManagedField): boolean {
  if (field instanceof HTMLInputElement && readInputType(field) === 'password') return true;
  const autoComplete = String(field.getAttribute('autocomplete') ?? '').toLowerCase();
  return autoComplete.includes('password') || autoComplete === 'one-time-code';
}

function usesComponentSuggestions(field: ManagedField): boolean {
  return field.dataset.inputAssist === 'component-suggestions';
}

function isPickerField(field: ManagedField): field is HTMLInputElement {
  return field instanceof HTMLInputElement && PICKER_INPUT_TYPES.has(readInputType(field));
}

function supportsHistory(field: ManagedField): boolean {
  if (isSensitiveField(field) || usesComponentSuggestions(field) || isPickerField(field)) return false;
  if (field instanceof HTMLTextAreaElement) return true;
  return HISTORY_INPUT_TYPES.has(readInputType(field));
}

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function extractLabelText(field: ManagedField): string {
  const labelledBy = normalizeText(field.getAttribute('aria-labelledby'));
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => normalizeText(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  const parentLabel = field.closest('label');
  if (parentLabel) {
    const cloned = parentLabel.cloneNode(true) as HTMLElement;
    cloned.querySelectorAll('input, textarea, select').forEach((node) => node.remove());
    const text = normalizeText(cloned.textContent);
    if (text) return text;
  }
  const explicitLabel = normalizeText(document.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.textContent);
  if (explicitLabel) return explicitLabel;
  return '';
}

function deriveFieldKey(field: ManagedField): string | null {
  const explicit = normalizeText(field.dataset.inputAssistKey);
  if (explicit) return explicit;
  const parts = [
    extractLabelText(field),
    normalizeText(field.getAttribute('name')),
    normalizeText(field.id),
    normalizeText(field.getAttribute('placeholder')),
    normalizeText(field.getAttribute('aria-label')),
    normalizeText(field.getAttribute('title')),
  ].filter(Boolean);
  if (!parts.length) return null;
  return parts.slice(0, 3).join('::').slice(0, 180);
}

function sanitizeStoredHistory(raw: unknown): HistoryMap {
  if (!raw || typeof raw !== 'object') return {};
  const result: HistoryMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const safeKey = normalizeText(key);
    if (!safeKey || !Array.isArray(value)) continue;
    const items = value
      .map((entry) => String(entry ?? '').trim())
      .filter((entry) => entry.length > 0 && entry.length <= MAX_STORED_VALUE_LENGTH)
      .slice(0, MAX_HISTORY_PER_FIELD);
    if (items.length) result[safeKey] = items;
  }
  return result;
}

function loadHistory(storageKey: string): HistoryMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    return sanitizeStoredHistory(JSON.parse(raw));
  } catch {
    return {};
  }
}

function saveHistory(storageKey: string, history: HistoryMap) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(history));
  } catch {
    // Ignore storage quota errors and keep assist working in-memory.
  }
}

function valueForStorage(field: ManagedField): string | null {
  const value = String(field.value ?? '').trim();
  if (!value) return null;
  if (value.length > MAX_STORED_VALUE_LENGTH) return null;
  if (!supportsHistory(field)) return null;
  if (field instanceof HTMLTextAreaElement && value.split(/\r?\n/).length > 3) return null;
  return value;
}

function upsertHistory(history: HistoryMap, key: string, value: string): HistoryMap {
  const existing = Array.isArray(history[key]) ? history[key] : [];
  const nextList = [value, ...existing.filter((entry) => entry !== value)].slice(0, MAX_HISTORY_PER_FIELD);
  const nextHistory: HistoryMap = { ...history, [key]: nextList };
  const keys = Object.keys(nextHistory);
  if (keys.length <= MAX_STORED_FIELDS) return nextHistory;
  for (const staleKey of keys.slice(MAX_STORED_FIELDS)) delete nextHistory[staleKey];
  return nextHistory;
}

function selectAll(field: ManagedField) {
  window.requestAnimationFrame(() => {
    if (document.activeElement !== field) return;
    try {
      field.select();
    } catch {
      // Some browser-native controls do not support text selection.
    }
  });
}

function openPicker(field: HTMLInputElement) {
  window.requestAnimationFrame(() => {
    if (document.activeElement !== field) return;
    try {
      field.showPicker?.();
    } catch {
      // Older browsers or restricted contexts may not allow programmatic picker open.
    }
  });
}

function computePopupRect(field: ManagedField): PopupRect {
  const rect = field.getBoundingClientRect();
  const gap = 6;
  const padding = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 240), Math.max(240, viewportWidth - padding * 2));
  const estimatedHeight = 200;

  let left = rect.left;
  if (left + width > viewportWidth - padding) left = viewportWidth - padding - width;
  if (left < padding) left = padding;

  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - gap - padding);
  const spaceAbove = Math.max(0, rect.top - gap - padding);
  const preferTop = spaceBelow < Math.min(180, estimatedHeight) && spaceAbove > spaceBelow;
  const maxHeight = Math.max(100, Math.min(220, preferTop ? spaceAbove : spaceBelow));
  const top = preferTop ? Math.max(padding, rect.top - maxHeight - gap) : Math.min(viewportHeight - padding - maxHeight, rect.bottom + gap);

  return { left, top, width, maxHeight };
}

function buildPopupState(field: ManagedField, history: HistoryMap): PopupState | null {
  const value = String(field.value ?? '').trim();
  if (!value || usesComponentSuggestions(field) || isSensitiveField(field) || isPickerField(field)) return null;
  const fieldKey = deriveFieldKey(field);
  const items: PopupItem[] = [{ value, kind: 'current' }];
  if (fieldKey) {
    const recent = history[fieldKey] ?? [];
    for (const entry of recent) {
      if (entry === value) continue;
      items.push({ value: entry, kind: 'history' });
      if (items.length >= MAX_HISTORY_PER_FIELD) break;
    }
  }
  return {
    target: field,
    value,
    items,
    ...computePopupRect(field),
  };
}

function setFieldValue(field: ManagedField, nextValue: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(field, nextValue);
  else field.value = nextValue;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Fallback for browsers without Clipboard API permissions.
  }
  const helper = document.createElement('textarea');
  helper.value = value;
  helper.setAttribute('readonly', 'true');
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  helper.style.pointerEvents = 'none';
  document.body.appendChild(helper);
  helper.select();
  try {
    document.execCommand('copy');
  } finally {
    helper.remove();
  }
}

function readPalette() {
  const dark = document.body.dataset.theme === 'dark';
  return dark
    ? {
        surface: '#0f172a',
        surfaceAlt: '#111827',
        border: 'rgba(148, 163, 184, 0.28)',
        text: '#e2e8f0',
        muted: '#94a3b8',
        accent: 'rgba(96, 165, 250, 0.18)',
        current: 'rgba(129, 140, 248, 0.18)',
        button: 'rgba(15, 23, 42, 0.92)',
      }
    : {
        surface: '#ffffff',
        surfaceAlt: '#f8fafc',
        border: 'rgba(15, 23, 42, 0.16)',
        text: '#0f172a',
        muted: '#64748b',
        accent: 'rgba(96, 165, 250, 0.16)',
        current: 'rgba(129, 140, 248, 0.14)',
        button: 'rgba(255, 255, 255, 0.96)',
      };
}

export function GlobalInputAssist(props: { storageKey: string }) {
  const historyRef = useRef<HistoryMap>({});
  const popupRef = useRef<HTMLDivElement | null>(null);
  const activeFieldRef = useRef<ManagedField | null>(null);
  const lastFocusTimeRef = useRef(0);
  const [popup, setPopup] = useState<PopupState | null>(null);

  useEffect(() => {
    historyRef.current = loadHistory(props.storageKey);
  }, [props.storageKey]);

  useEffect(() => {
    const rememberFieldValue = (field: ManagedField) => {
      const key = deriveFieldKey(field);
      const value = valueForStorage(field);
      if (!key || !value) return;
      const nextHistory = upsertHistory(historyRef.current, key, value);
      historyRef.current = nextHistory;
      saveHistory(props.storageKey, nextHistory);
    };

    const refreshPopup = (field: ManagedField) => {
      if (document.activeElement !== field) {
        setPopup((prev) => (prev?.target === field ? null : prev));
        return;
      }
      setPopup(buildPopupState(field, historyRef.current));
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!isManagedField(target) || target.dataset.inputAssist === 'off') {
        activeFieldRef.current = null;
        setPopup(null);
        return;
      }
      activeFieldRef.current = target;
      lastFocusTimeRef.current = Date.now();
      const hasValue = String(target.value ?? '').trim().length > 0;
      if (!hasValue) {
        setPopup(null);
        return;
      }
      if (isPickerField(target)) {
        setPopup(null);
        openPicker(target);
        return;
      }
      window.requestAnimationFrame(() => refreshPopup(target));
    };

    const onInput = (event: Event) => {
      const target = event.target;
      if (!isManagedField(target)) return;
      if (activeFieldRef.current !== target) return;
      refreshPopup(target);
    };

    const onChange = (event: Event) => {
      const target = event.target;
      if (!isManagedField(target)) return;
      rememberFieldValue(target);
      if (activeFieldRef.current === target) refreshPopup(target);
    };

    const onFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (!isManagedField(target)) return;
      rememberFieldValue(target);
      if (activeFieldRef.current === target) activeFieldRef.current = null;
      window.setTimeout(() => {
        if (document.activeElement === target) return;
        setPopup((prev) => (prev?.target === target ? null : prev));
      }, 0);
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!isManagedField(target)) return;
      if (activeFieldRef.current !== target) return;
      if (Date.now() - lastFocusTimeRef.current < 300) return;
      setPopup((prev) => (prev?.target === target ? null : buildPopupState(target, historyRef.current)));
    };

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('click', onClick, true);

    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('click', onClick, true);
    };
  }, [props.storageKey]);

  useEffect(() => {
    if (!popup) return;

    const updatePosition = () => {
      if (!popup.target.isConnected || document.activeElement !== popup.target) {
        setPopup(null);
        return;
      }
      setPopup((prev) => {
        if (!prev || prev.target !== popup.target) return prev;
        const next = buildPopupState(popup.target, historyRef.current);
        return next;
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (popup.target.contains(target) || popupRef.current?.contains(target))) return;
      setPopup(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPopup(null);
    };

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [popup]);

  if (!popup) return null;

  const palette = readPalette();
  const canClear = !popup.target.readOnly && !popup.target.disabled;

  return createPortal(
    <div
      ref={popupRef}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
        position: 'fixed',
        left: popup.left,
        top: popup.top,
        width: popup.width,
        zIndex: 5200,
        background: palette.surface,
        border: `1px solid ${palette.border}`,
        borderRadius: 8,
        boxShadow: '0 8px 20px rgba(15, 23, 42, 0.18)',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '4px 8px', borderBottom: `1px solid ${palette.border}`, background: palette.surfaceAlt }}>
        <div style={{ fontSize: 11, color: palette.muted }}>Скопировать, заменить или выбрать из недавних</div>
      </div>
      <div style={{ maxHeight: popup.maxHeight, overflowY: 'auto' }}>
        {popup.items.map((item, idx) => {
          const isCurrent = item.kind === 'current';
          return (
            <button
              key={`${item.kind}-${idx}-${item.value}`}
              type="button"
              onClick={() => {
                setFieldValue(popup.target, item.value);
                popup.target.focus();
                selectAll(popup.target);
                setPopup(null);
              }}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '5px 8px',
                border: 'none',
                borderBottom: idx === popup.items.length - 1 ? 'none' : `1px solid ${palette.border}`,
                background: isCurrent ? palette.current : 'transparent',
                color: palette.text,
                cursor: 'pointer',
              }}
            >
              <div style={{ fontSize: 12, color: palette.muted }}>{isCurrent ? 'Текущее значение' : 'Недавнее значение'}</div>
              <div
                style={{
                  marginTop: 2,
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={item.value}
              >
                {item.value}
              </div>
            </button>
          );
        })}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '4px 8px',
          borderTop: `1px solid ${palette.border}`,
          background: palette.surfaceAlt,
        }}
      >
        <button
          type="button"
          onClick={() => {
            void copyText(popup.value);
            popup.target.focus();
            setPopup(null);
          }}
          style={{
            flex: 1,
            padding: '4px 8px',
            borderRadius: 6,
            border: `1px solid ${palette.border}`,
            background: palette.button,
            color: palette.text,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Скопировать
        </button>
        {canClear && (
          <button
            type="button"
            onClick={() => {
              setFieldValue(popup.target, '');
              popup.target.focus();
              setPopup(null);
            }}
            style={{
              flex: 1,
              padding: '4px 8px',
              borderRadius: 6,
              border: `1px solid ${palette.border}`,
              background: palette.accent,
              color: palette.text,
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Очистить
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
