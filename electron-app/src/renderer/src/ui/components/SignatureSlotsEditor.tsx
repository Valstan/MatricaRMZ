import React, { useMemo, useRef } from 'react';

import {
  formatEmployeeSurnameInitials,
  type WorkOrderSignatureEmployee,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { EntityReferenceField } from './EntityReferenceField.js';
import { Input } from './Input.js';
import { ListReorderHandle } from './ListReorderHandle.js';
import type { SearchSelectOption } from './SearchSelect.js';
import { useListReorder } from '../hooks/useListReorder.js';
import { buildSearchOption, joinOptionHint, joinOptionSearch } from '../utils/selectOptions.js';

/**
 * РЕДАКТОР БЛОКА ПОДПИСЕЙ печатной формы (владелец 23.11.2026).
 *
 * Задача владельца: «блок подписей нужно сделать редактируемым, чтобы можно было
 * добавлять другие подписи, с другими людьми, с другими профессиями, должностями.
 * Добавлять и удалять подписи». До этого блок был только списком галочек «печатать /
 * не печатать»: убрать подпись можно было, а добавить — нет.
 *
 * Что делает редактор:
 *  · **должность** строки подписи — текстом (роли не фиксированы: оператор вписывает
 *    свою, подсказки — из `captionSuggestions`);
 *  · **человек** — выбором из кадрового реестра; тогда печатается ФИО из его карточки
 *    и видна его профессия (должность);
 *  · **ФИО от руки** — когда сотрудник не выбран (подпись подписывают на месте);
 *  · **удаление** строки и **добавление** новой;
 *  · **порядок строк** — общим китом списков (ручка «⠿»), как везде в программе.
 *
 * Почему отдельный компонент, а не код в печатной форме: блок подписей — общий для
 * документов (наряд уже редактирует свои слоты), и правило «везде одинаково» требует
 * одного места, а не копии в каждой форме.
 */

/**
 * Строка блока подписей.
 *
 * `id` — ключ строки ТОЛЬКО для интерфейса: по нему печатная форма помнит, какую
 * строку печатать, когда должность переписали или строки переставили. Идентификатор
 * подписи (должность) для этого не годится — он меняется при правке.
 */
export type SignatureSlotRow = {
  id: string;
  /** Должность/роль подписанта — печатается под строкой подписи. */
  caption: string;
  /** Сотрудник из кадрового реестра; null — подпись от руки. */
  employeeId: string | null;
  /** ФИО, если сотрудник не привязан (пишется от руки или взято из образца). */
  fullName: string;
};

/** Подсказки должностей для `datalist` — роли не фиксированы, но частые подсказываем. */
export type SignatureSlotRowHint = {
  /** Что напечатается под строкой подписи. */
  text: string;
  /** Откуда взялось имя — подсказка оператору. */
  source?: string;
};

/** Опции выбора сотрудника для `EntityReferenceField`. */
export function buildSignatureEmployeeOptions(employees: readonly WorkOrderSignatureEmployee[]): SearchSelectOption[] {
  return employees.map((employee) => {
    const label = employee.displayName || employee.fullName || employee.id || '';
    const hint = joinOptionHint([employee.position]);
    const search = joinOptionSearch([employee.displayName, employee.fullName, employee.id, employee.position]);
    return buildSearchOption({
      id: String(employee.id ?? ''),
      label,
      ...(hint ? { hintText: hint } : {}),
      ...(search ? { searchText: search } : {}),
    });
  });
}

/**
 * Что напечатается под строкой подписи: сотрудник — из его карточки, иначе вписанное
 * ФИО. Тот же источник, что у печатной модели, — иначе редактор показывал бы одно,
 * а на бумаге было бы другое.
 */
export function signatureSlotRowHint(
  row: SignatureSlotRow,
  employees: readonly WorkOrderSignatureEmployee[],
): SignatureSlotRowHint {
  const employeeId = String(row.employeeId ?? '').trim();
  const employee = employeeId ? employees.find((e) => String(e.id ?? '') === employeeId) : undefined;
  if (employee) {
    const name = formatEmployeeSurnameInitials(employee);
    const position = String(employee.position ?? '').trim();
    const text = [name, position].filter(Boolean).join(' · ');
    return { text, source: 'из карточки сотрудника' };
  }
  const fullName = String(row.fullName ?? '').trim();
  return { text: fullName, source: 'от руки' };
}

/** Редактор блока подписей: список строк на ките + добавление/удаление. */
export function SignatureSlotsEditor(props: {
  /** Строки блока в текущем порядке. */
  rows: SignatureSlotRow[];
  /** Можно ли править состав (право + состояние документа). */
  canEdit: boolean;
  /** Кадровый реестр: ФИО, должность — для подсказки под строкой. */
  employees: readonly WorkOrderSignatureEmployee[];
  /**
   * Ключ рейтинга выбора сотрудника (план autumn-2026 §D4): ключ называет РОЛЬ
   * («подписант ПП», «подписант наряда»), а не экран — иначе рейтинги ролей смешались бы.
   */
  rankKey: string;
  /** Состав изменился — документ сохраняет новый. */
  onChange: (rows: SignatureSlotRow[]) => void;
  /** Подсказки должностей (datalist). */
  captionSuggestions?: readonly string[];
  /** Дополнительное управление строкой — например, галочка «печатать». */
  renderExtra?: (row: SignatureSlotRow, index: number) => React.ReactNode;
  /** Подпись кнопки добавления. */
  addLabel?: string;
  /** Пояснение под списком. */
  hint?: React.ReactNode;
  /** id списка подсказок (datalist) — уникальный в форме. */
  datalistId?: string;
}) {
  const reorder = useListReorder({
    rows: props.rows,
    canReorder: props.canEdit,
    onReorder: (rows) => props.onChange(rows),
  });

  // Ключ новой строки — только для интерфейса; хватает счётчика и времени.
  const newKeyCounter = useRef(0);
  const nextRowId = () => {
    newKeyCounter.current += 1;
    return `slot-new-${Date.now()}-${newKeyCounter.current}`;
  };

  const setRow = (index: number, patch: Partial<SignatureSlotRow>) => {
    props.onChange(props.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    props.onChange(props.rows.filter((_, i) => i !== index));
  };

  const addRow = () => {
    props.onChange([...props.rows, { id: nextRowId(), caption: '', employeeId: null, fullName: '' }]);
  };

  const hints = useMemo(
    () => props.rows.map((row) => signatureSlotRowHint(row, props.employees)),
    [props.rows, props.employees],
  );

  // Опции выбора сотрудника — ОДИН массив на весь список: `EntityReferenceField`
  // пересчитывает по нему выбранное и сбрасывает набранный запрос, а новый массив
  // на каждом рендере сбрасывал бы запрос в пикере при правке соседней строки.
  const employeeOptions = useMemo(() => buildSignatureEmployeeOptions(props.employees), [props.employees]);

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <datalist id={props.datalistId ?? 'signature-slot-captions'}>
        {(props.captionSuggestions ?? []).map((caption) => (
          <option key={caption} value={caption} />
        ))}
      </datalist>
      <div ref={reorder.scopeRef} style={{ display: 'grid', gap: 6 }}>
        {props.rows.map((row, index) => (
          <div
            key={row.id}
            data-list-row="true"
            data-list-row-key={reorder.keys[index] ?? ''}
            style={{
              display: 'grid',
              gap: 6,
              padding: '8px 10px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              ...reorder.rowStyle(reorder.keys[index] ?? ''),
            }}
            onDragOver={reorder.onDragOver}
            onDrop={reorder.onDrop}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(150px, 1fr) minmax(200px, 1.2fr) auto auto',
                gap: 8,
                alignItems: 'center',
              }}
            >
              {props.renderExtra ? props.renderExtra(row, index) : null}
              <Input
                list={props.datalistId ?? 'signature-slot-captions'}
                value={row.caption}
                disabled={!props.canEdit}
                placeholder="Должность (напр. «Начальник цеха № 4»)"
                onChange={(e) => setRow(index, { caption: e.target.value })}
              />
              <EntityReferenceField
                target="employee"
                targetLabel="Сотрудник"
                value={row.employeeId || null}
                options={employeeOptions}
                disabled={!props.canEdit}
                rankKey={props.rankKey}
                onChange={(next) => setRow(index, { employeeId: next || null })}
                placeholder="Сотрудник (пусто — подпись от руки)"
              />
              {props.canEdit ? (
                <Button
                  variant="ghost"
                  style={{ color: 'var(--danger)' }}
                  title="Убрать подпись"
                  onClick={() => removeRow(index)}
                >
                  ✕
                </Button>
              ) : (
                <span />
              )}
              <ListReorderHandle
                {...reorder.handleProps(reorder.keys[index] ?? '', { label: `подпись ${index + 1}` })}
              />
            </div>
            {!row.employeeId ? (
              <Input
                value={row.fullName}
                disabled={!props.canEdit}
                placeholder="ФИО от руки (если сотрудник не выбран)"
                onChange={(e) => setRow(index, { fullName: e.target.value })}
              />
            ) : null}
            <div style={{ fontSize: 12, color: 'var(--muted)', minHeight: 14, wordBreak: 'break-word' }}>
              {hints[index]?.text ? `${hints[index]?.text} (${hints[index]?.source})` : 'Подпись и расшифровка от руки'}
            </div>
          </div>
        ))}
      </div>
      {props.rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>Подписей нет — добавьте нужные.</div>
      ) : null}
      {props.canEdit ? (
        <div>
          <Button variant="ghost" onClick={addRow}>
            {props.addLabel ?? '+ Добавить подпись'}
          </Button>
        </div>
      ) : null}
      {props.hint ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{props.hint}</div> : null}
    </div>
  );
}
