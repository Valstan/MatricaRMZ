import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Input } from './Input.js';

/**
 * Полупрозрачная плашка с полным текстом поля — показывается НАД полем, когда содержимое
 * не помещается по ширине (`scrollWidth > clientWidth`) и поле в фокусе/под курсором.
 * Оператор видит полное значение (напр. длинное ФИО/должность), не прокручивая поле.
 * Presentational — позиционируется в `position:relative`-контейнере родителя.
 */
export function OverflowPlate(props: { text: string; visible: boolean }): React.ReactElement | null {
  if (!props.visible || !props.text.trim()) return null;
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        marginBottom: 4,
        maxWidth: 'min(520px, 90vw)',
        padding: '4px 8px',
        background: 'rgba(15, 23, 42, 0.88)',
        color: '#fff',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: 1.35,
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.25)',
        pointerEvents: 'none',
        zIndex: 60,
      }}
    >
      {props.text}
    </div>
  );
}

/**
 * Хук измерения переполнения одного `<input>`. Возвращает ref для поля, флаг видимости
 * плашки и хендлеры фокуса/наведения. Пересчёт — на изменение текста и на focus/hover.
 */
export function useOverflowTooltip(text: string): {
  ref: React.RefObject<HTMLInputElement>;
  visible: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
} {
  const ref = useRef<HTMLInputElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [active, setActive] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    setOverflowing(el ? el.scrollWidth > el.clientWidth + 1 : false);
  }, []);

  useEffect(() => {
    measure();
  }, [text, measure]);

  return {
    ref,
    visible: active && overflowing,
    onFocus: () => {
      measure();
      setActive(true);
    },
    onBlur: () => setActive(false),
    onMouseEnter: () => {
      measure();
      setActive(true);
    },
    onMouseLeave: () => setActive(false),
  };
}

/**
 * `Input` с всплывающей плашкой полного текста при переполнении. Резиновый по ширине
 * (100% контейнера), плашка не перехватывает клики. Пропсы прозрачно проброшены в `Input`.
 */
export const OverflowTooltipInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  (props, forwardedRef) => {
    const text = props.value == null ? '' : String(props.value);
    const tip = useOverflowTooltip(text);

    const setRefs = (el: HTMLInputElement | null) => {
      (tip.ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
    };

    return (
      <div style={{ position: 'relative', width: '100%', minWidth: 0 }}>
        <OverflowPlate text={text} visible={tip.visible} />
        <Input
          {...props}
          ref={setRefs}
          onFocus={(e) => {
            tip.onFocus();
            props.onFocus?.(e);
          }}
          onBlur={(e) => {
            tip.onBlur();
            props.onBlur?.(e);
          }}
          onMouseEnter={(e) => {
            tip.onMouseEnter();
            props.onMouseEnter?.(e);
          }}
          onMouseLeave={(e) => {
            tip.onMouseLeave();
            props.onMouseLeave?.(e);
          }}
        />
      </div>
    );
  },
);

OverflowTooltipInput.displayName = 'OverflowTooltipInput';
