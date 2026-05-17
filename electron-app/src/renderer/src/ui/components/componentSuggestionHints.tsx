import React, { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';

export function computeComponentHintButtonRect(anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = 92;
  const height = 26;
  const left = Math.min(window.innerWidth - width - 8, rect.right - width);
  const top = Math.max(8, rect.top + (rect.height - height) / 2);
  return { left, top, width, height };
}

export function useComponentSuggestionSuppress() {
  const [suppressed, setSuppressed] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);

  const suppress = useCallback(() => {
    setSuppressed(true);
    setHintVisible(true);
  }, []);

  const restore = useCallback(() => {
    setSuppressed(false);
    setHintVisible(false);
  }, []);

  const onFocus = useCallback(
    (openDropdown: () => void) => {
      if (suppressed) {
        setHintVisible(true);
        return;
      }
      setHintVisible(false);
      openDropdown();
    },
    [suppressed],
  );

  const onBlur = useCallback(() => {
    window.setTimeout(() => {
      setSuppressed(false);
      setHintVisible(false);
    }, 0);
  }, []);

  const shouldOpenDropdown = useCallback(() => !suppressed, [suppressed]);

  return { suppressed, hintVisible, suppress, restore, onFocus, onBlur, shouldOpenDropdown, setHintVisible };
}

export function ComponentSuggestionsHintButton(props: {
  anchor: HTMLElement | null;
  visible: boolean;
  onShow: () => void;
}) {
  if (!props.visible || !props.anchor || !props.anchor.isConnected) return null;

  const rect = computeComponentHintButtonRect(props.anchor);

  return createPortal(
    <button
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        props.onShow();
      }}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        zIndex: 5190,
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        color: 'var(--text)',
        fontSize: 12,
        cursor: 'pointer',
        boxShadow: 'var(--chat-menu-shadow)',
      }}
      title="Показать подсказки для поля"
    >
      Подсказки
    </button>,
    document.body,
  );
}

export function ComponentSuggestionsPopupHeader(props: { onHide: () => void }) {
  return (
    <div
      style={{
        padding: '4px 8px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface2)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--muted)', flex: 1 }}>Выберите значение из списка</div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          props.onHide();
        }}
        style={{
          padding: '2px 8px',
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text)',
          cursor: 'pointer',
          fontSize: 11,
          whiteSpace: 'nowrap',
        }}
      >
        Скрыть
      </button>
    </div>
  );
}
