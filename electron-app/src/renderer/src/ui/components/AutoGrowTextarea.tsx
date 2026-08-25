import React, { useEffect, useRef } from 'react';

/**
 * Многострочное поле, которое подгоняет высоту под текст: оператор видит вставленный
 * акт целиком, а не в окошке на три строки.
 *
 * Два неочевидных места:
 *  1. Пересчёт висит на `value`, а не только на вводе с клавиатуры, — иначе поле не
 *     вырастет после программной вставки (кнопки «Вставить из буфера / из файла»).
 *  2. Проп `visible` обязателен для полей на скрытых вкладках: панели карточки не
 *     размонтируются, а прячутся через `hidden`, и у скрытого элемента `scrollHeight`
 *     равен нулю — без пересчёта при показе поле осталось бы схлопнутым.
 */
export function AutoGrowTextarea(props: {
  value: string;
  onChange: (next: string) => void;
  visible: boolean;
  disabled?: boolean;
  placeholder?: string;
  minRows?: number;
  title?: string;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  dataTag?: string;
}) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = props.inputRef ?? ownRef;
  const minRows = props.minRows ?? 3;

  useEffect(() => {
    const el = ref.current;
    if (!el || !props.visible) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value, props.visible, ref]);

  return (
    <textarea
      ref={ref}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      rows={minRows}
      style={{
        width: '100%',
        minHeight: `${minRows * 1.6}em`,
        resize: 'vertical',
        overflow: 'hidden',
        lineHeight: 1.4,
      }}
      {...(props.disabled != null ? { disabled: props.disabled } : {})}
      {...(props.placeholder ? { placeholder: props.placeholder } : {})}
      {...(props.title ? { title: props.title } : {})}
      {...(props.dataTag ? { 'data-recl-field': props.dataTag } : {})}
    />
  );
}
