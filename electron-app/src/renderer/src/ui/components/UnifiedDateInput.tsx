import React, { useMemo, useState } from 'react';
import DatePicker from 'react-datepicker';

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function parseValue(raw: string, withTime: boolean): Date | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (withTime) {
    const [datePart = '', timePart = '00:00'] = value.split('T');
    const [y = NaN, m = NaN, d = NaN] = datePart.split('-').map((x) => Number(x));
    const [hh = 0, mm = 0] = timePart.split(':').map((x) => Number(x));
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    return new Date(y, m - 1, d, Number.isFinite(hh) ? hh : 0, Number.isFinite(mm) ? mm : 0, 0, 0);
  }
  const [y = NaN, m = NaN, d = NaN] = value.split('-').map((x) => Number(x));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function formatValue(date: Date | null, withTime: boolean): string {
  if (!date) return '';
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  if (!withTime) return `${y}-${m}-${d}`;
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

export const UnifiedDateInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function UnifiedDateInput(
  props,
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const type = String(props.type ?? 'date');
  const withTime = type === 'datetime-local';
  const selected = useMemo(() => parseValue(String(props.value ?? ''), withTime), [props.value, withTime]);
  const minDate = useMemo(() => parseValue(String(props.min ?? ''), withTime), [props.min, withTime]);
  const maxDate = useMemo(() => parseValue(String(props.max ?? ''), withTime), [props.max, withTime]);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '4px 6px',
    border: focused ? '1px solid var(--input-border-focus)' : '1px solid var(--input-border)',
    outline: 'none',
    background: props.disabled ? 'var(--input-bg-disabled)' : 'var(--input-bg)',
    color: 'var(--text)',
    fontSize: 13,
    lineHeight: 1.2,
    minHeight: 28,
    boxShadow: focused ? 'var(--input-shadow-focus)' : 'var(--input-shadow)',
    ...(props.style ?? {}),
  };

  function emitChange(nextValue: string) {
    props.onChange?.(
      {
        target: { value: nextValue },
        currentTarget: { value: nextValue },
      } as unknown as React.ChangeEvent<HTMLInputElement>,
    );
  }

  const optionalPickerProps = {
    ...(props.placeholder !== undefined ? { placeholderText: props.placeholder } : {}),
    ...(props.name !== undefined ? { name: props.name } : {}),
    ...(props.required !== undefined ? { required: props.required } : {}),
    ...(props.id !== undefined ? { id: props.id } : {}),
    ...(minDate ? { minDate } : {}),
    ...(maxDate ? { maxDate } : {}),
  };

  return (
    <DatePicker
      selected={selected}
      open={open}
      onClickOutside={() => setOpen(false)}
      onCalendarClose={() => setOpen(false)}
      onCalendarOpen={() => setOpen(true)}
      onChange={(next: Date | null) => emitChange(formatValue(next, withTime))}
      onSelect={() => setOpen(false)}
      disabled={Boolean(props.disabled)}
      showTimeSelect={withTime}
      timeIntervals={15}
      dateFormat={withTime ? 'dd.MM.yyyy HH:mm' : 'dd.MM.yyyy'}
      className="matrica-datepicker-input"
      calendarClassName="matrica-datepicker-calendar"
      popperClassName="matrica-datepicker-popper"
      onFocus={(e) => {
        setFocused(true);
        setOpen(true);
        try {
          (e.currentTarget as HTMLInputElement).setSelectionRange(0, 0);
        } catch {
          // ignore selection errors for non-text implementations
        }
        props.onFocus?.(e as unknown as React.FocusEvent<HTMLInputElement>);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e as unknown as React.FocusEvent<HTMLInputElement>);
      }}
      onInputClick={() => setOpen(true)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
        props.onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
      }}
      autoComplete="off"
      customInput={<input ref={ref} style={inputStyle} data-autogrow="off" />}
      {...optionalPickerProps}
    />
  );
});
