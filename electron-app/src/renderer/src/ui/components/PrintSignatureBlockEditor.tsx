import React, { useId, useMemo } from 'react';

import {
  addPrintSignatureSlot,
  removePrintSignatureSlot,
  updatePrintSignatureSlot,
  type PrintSignatureSlot,
  type WorkOrderSignatureEmployee,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { EntityReferenceField } from './EntityReferenceField.js';
import { Input } from './Input.js';

/**
 * Редактор блока подписей печатной формы — общий слой (заказ владельца 23.11.2026).
 *
 * «В печатной форме блок подписей нужно сделать редактируемым, чтобы можно было
 * добавлять другие подписи, с другими людьми, с другими профессиями, должностями.
 * Добавлять и удалять подписи.»
 *
 * Строка подписи — это должность (печатается над линией) и человек: сотрудник из
 * базы **или** ФИО, вписанное от руки. Пустая строка — подпись подписывают от руки.
 *
 * Образец — блок подписей в наряде (`WorkOrderDetailsPage.tsx`): там уже умеют
 * добавлять, менять и удалять подписантов. Здесь тот же паттерн, но вынесенный в
 * общий компонент: форм, печатаемых мимо шаблона, больше одной (сегодня —
 * производственная программа), и правило подписей должно быть одно.
 *
 * Правка слота идёт **наверх** (`onChange`) — хранит её документ, а не окно
 * предпросмотра: иначе подпись, добавленная «на печать», не печаталась бы в
 * следующий раз.
 */
export function PrintSignatureBlockEditor(props: {
  /** Слоты блока: что печатается и что правится. */
  slots: readonly PrintSignatureSlot[];
  /** Сотрудники — из них выбирают подписанта. */
  employees: readonly WorkOrderSignatureEmployee[];
  /** Правка слотов: добавление, изменение, удаление. */
  onChange: (slots: readonly PrintSignatureSlot[]) => void;
  /** Подсказки должностей (подсказки в поле ввода — оператор может вписать свою). */
  suggestions?: readonly string[];
  /** Блок запрещено править (печать без права правки). */
  disabled?: boolean;
  /** Ключ рейтинга подписантов (кто в списке выбора выше). */
  rankKey?: string;
  /** Заголовок блока над списком. */
  title?: string;
  /**
   * Индексы слотов, которые печатаются (галочка «снять подпись»). `null` — галочек
   * нет: печатаются все слоты блока.
   */
  printedIndexes?: readonly number[] | null;
  /** Переключить «печатать / не печатать» для слота (правка только этого окна). */
  onTogglePrinted?: (index: number) => void;
}) {
  const listId = useId();
  const slots = props.slots ?? [];

  const employeeOptions = useMemo(
    () =>
      (props.employees ?? [])
        .map((employee) => {
          const id = String(employee.id ?? '').trim();
          if (!id) return null;
          const name = String(employee.fullName ?? employee.displayName ?? '').trim();
          const position = String(employee.position ?? '').trim();
          return { id, label: [name, position].filter(Boolean).join(' · ') };
        })
        .filter((option): option is { id: string; label: string } => option !== null),
    [props.employees],
  );

  const setSlot = (index: number, patch: Partial<PrintSignatureSlot>) => {
    props.onChange(updatePrintSignatureSlot(slots, index, patch));
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {props.title ? <div style={{ fontWeight: 600, fontSize: 13 }}>{props.title}</div> : null}
      <datalist id={listId}>
        {(props.suggestions ?? []).map((caption) => (
          <option key={caption} value={caption} />
        ))}
      </datalist>
      {slots.map((slot, index) => {
        const employee = slot.employeeId
          ? (props.employees ?? []).find((e) => String(e.id ?? '').trim() === slot.employeeId)
          : undefined;
        const unitLine = [employee?.position, String(employee?.fullName ?? employee?.displayName ?? '').trim()]
          .filter(Boolean)
          .join(' · ');
        return (
          <div
            key={`${slot.caption}-${index}`}
            style={{
              display: 'grid',
              gap: 6,
              padding: '8px 10px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
            }}
          >
            <div
              style={{
                // Поля складываются по ширине: в узкой колонке превью (240–300 px)
                // четыре поля в ряд нечитаемы, в широкой — помещаются в строку.
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                gap: 8,
                alignItems: 'center',
              }}
            >
              {props.printedIndexes ? (
                <input
                  type="checkbox"
                  data-print-signature-printed={index}
                  checked={props.printedIndexes.includes(index)}
                  onChange={() => props.onTogglePrinted?.(index)}
                  title="Подпись печатается"
                  style={{ marginTop: 2 }}
                />
              ) : null}
              <Input
                list={listId}
                value={slot.caption}
                disabled={props.disabled === true}
                placeholder="Должность (напр. «Начальник цеха»)"
                onChange={(e) => setSlot(index, { caption: e.target.value })}
              />
              <EntityReferenceField
                target="employee"
                targetLabel="Сотрудник"
                value={slot.employeeId || null}
                options={employeeOptions}
                disabled={props.disabled === true}
                optionsReady
                rankKey={props.rankKey ?? 'employee:print-signature'}
                onChange={(next) => setSlot(index, { employeeId: next || '' })}
                placeholder="Сотрудник (пусто — подпись от руки)"
              />
              <Input
                value={slot.fullName}
                disabled={props.disabled === true}
                placeholder="ФИО (пусто — из карточки сотрудника)"
                onChange={(e) => setSlot(index, { fullName: e.target.value })}
              />
              {props.disabled ? (
                <span />
              ) : (
                <Button
                  variant="ghost"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => props.onChange(removePrintSignatureSlot(slots, index))}
                >
                  Удалить
                </Button>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', minHeight: 14, wordBreak: 'break-word' }}>
              {unitLine || (slot.employeeId ? '' : 'Подпись и расшифровка от руки')}
            </div>
          </div>
        );
      })}
      {slots.length === 0 ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>Подписи не добавлены</div> : null}
      {props.disabled ? null : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" onClick={() => props.onChange(addPrintSignatureSlot(slots, {}))}>
            + Добавить подпись
          </Button>
        </div>
      )}
    </div>
  );
}
