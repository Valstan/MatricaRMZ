import React from 'react';

import { WORK_SHEET_COLUMN_TYPE_LABELS, type WorkSheetColumn } from '@matricarmz/shared';

import { Input } from './Input.js';
import { UnifiedDateInput } from './UnifiedDateInput.js';

/**
 * Редактор ОДНОГО поля вида работ — общий для карточки этапа работ и черновой строки в
 * списке (владелец 15.09.2026: «прямо в списке появлялась новая строка, и мы в ней всё
 * забивали»). Две копии разошлись бы на первой же новой колонке типа: галочка, дата,
 * выбор из вариантов, число и текст обязаны вводиться одинаково в обоих местах.
 */
export function WorkSheetFieldEditor(props: {
  column: WorkSheetColumn;
  value: unknown;
  disabled?: boolean;
  onChange: (next: unknown) => void;
  /** Компактный вид для ячейки таблицы: без подписи типа у галочки. */
  compact?: boolean;
}) {
  const { column: col, value, disabled, onChange } = props;
  if (col.type === 'boolean') {
    return (
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {props.compact ? null : <span className="ui-muted">{WORK_SHEET_COLUMN_TYPE_LABELS.boolean}</span>}
      </label>
    );
  }
  if (col.type === 'date') {
    return (
      <UnifiedDateInput
        type="date"
        disabled={disabled}
        value={toWorkSheetDateInput(typeof value === 'number' ? value : fromWorkSheetDateInput(String(value ?? '')))}
        onChange={(e) => onChange(fromWorkSheetDateInput(e.target.value))}
      />
    );
  }
  if (col.type === 'choice' && (col.options?.length ?? 0) > 0) {
    return (
      <select value={String(value ?? '')} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {col.options!.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      value={String(value ?? '')}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder={col.type === 'number' ? 'число' : props.compact ? col.label : ''}
      inputMode={col.type === 'number' ? 'decimal' : undefined}
      style={props.compact ? { minWidth: 90 } : undefined}
    />
  );
}

/** Миллисекунды → `YYYY-MM-DD` для `<input type="date">` (локальная дата, без сдвига по UTC). */
export function toWorkSheetDateInput(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** `YYYY-MM-DD` → миллисекунды начала дня (локально); пусто / мусор → `null`. */
export function fromWorkSheetDateInput(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const ms = Date.parse(`${s}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}
