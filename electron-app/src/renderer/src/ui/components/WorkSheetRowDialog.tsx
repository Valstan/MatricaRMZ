import React, { useEffect, useMemo, useState } from 'react';

import {
  WORK_SHEET_COLUMN_TYPE_LABELS,
  formatWorkSheetValue,
  type EngineListItem,
  type WorkSheetColumn,
  type WorkSheetRow,
  type WorkSheetType,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { EntityReferenceField } from './EntityReferenceField.js';
import { Input } from './Input.js';
import { UnifiedDateInput } from './UnifiedDateInput.js';
import type { SearchSelectOption } from './SearchSelect.js';
import { buildSearchOption, joinOptionHint, joinOptionSearch } from '../utils/selectOptions.js';

export type WorkshopOption = { id: string; label: string };

function toDateInput(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromDateInput(raw: string): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const ms = Date.parse(`${s}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Строка ведомости: двигатель, дата, цех, примечание и поля узла. Одна форма на добавление и
 * правку — правка приходит с тем же id, и main-процесс бьёт в ту же запись истории (без дублей).
 * Узел меняется только у новой строки: у существующей поля уже принадлежат его набору колонок.
 */
export function WorkSheetRowDialog(props: {
  types: WorkSheetType[];
  /** Узел активной вкладки — предвыбор для новой строки; `null` — вкладка «Все». */
  initialTypeCode: string | null;
  row: WorkSheetRow | null;
  engines: EngineListItem[];
  enginesReady: boolean;
  workshops: WorkshopOption[];
  canDelete: boolean;
  onClose: () => void;
  onSaved: (result: { repair: { applied: boolean; reason?: string } | null; typeName: string }) => void;
  onDeleted: () => void;
  onOpenEngine?: (id: string) => void;
}) {
  const editing = props.row !== null;
  const [typeCode, setTypeCode] = useState<string>(props.row?.typeCode ?? props.initialTypeCode ?? props.types[0]?.code ?? '');
  const type = useMemo(() => props.types.find((t) => t.code === typeCode) ?? null, [props.types, typeCode]);

  // Узла может не быть в справочнике: клиент офлайн (справочник — REST) или узел заведён в
  // архив. Правку это пустить под откос не должно — строка самоописываема, и её собственные
  // поля несут подпись и тип. Новую строку без узла завести по-прежнему нельзя: у неё полей нет.
  const rowColumns = useMemo<WorkSheetColumn[]>(
    () => (props.row?.fields ?? []).map((f) => ({ code: f.code, label: f.label || f.code, type: f.type })),
    [props.row],
  );
  const effectiveType = useMemo(() => {
    if (type) return type;
    if (!editing || !props.row) return null;
    // completesRepair здесь false намеренно: статус ставится только при СОЗДАНИИ строки,
    // а это ветка правки — подставлять сюда догадку о чужом узле незачем.
    return { id: props.row.typeId, code: props.row.typeCode, name: props.row.typeName, completesRepair: false, columns: rowColumns, workshopId: null };
  }, [type, editing, props.row, rowColumns]);
  const columns = effectiveType?.columns ?? [];
  const [engineId, setEngineId] = useState<string | null>(props.row?.engineId ?? null);
  const [date, setDate] = useState<string>(toDateInput(props.row?.at ?? Date.now()));
  const [workshopId, setWorkshopId] = useState<string>(props.row?.workshopId ?? type?.workshopId ?? '');
  const [note, setNote] = useState<string>(props.row?.note ?? '');
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const f of props.row?.fields ?? []) out[f.code] = f.value;
    return out;
  });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Смена узла у новой строки подставляет его цех; введённые поля чужого узла — не переносим.
  useEffect(() => {
    if (editing) return;
    setWorkshopId(type?.workshopId ?? '');
    setValues({});
  }, [editing, type?.code, type?.workshopId]);

  const engineOptions: SearchSelectOption[] = useMemo(
    () =>
      props.engines.map((e) => {
        const hint = joinOptionHint([e.internalNumberFull ? `внутр. ${e.internalNumberFull}` : '', e.engineBrand]);
        const search = joinOptionSearch([e.engineNumber ?? '', e.internalNumberFull ?? '', e.id, e.engineBrand ?? '']);
        return buildSearchOption({ id: e.id, label: e.engineNumber || e.id, ...(hint ? { hintText: hint } : {}), ...(search ? { searchText: search } : {}) });
      }),
    [props.engines],
  );

  const setValue = (code: string, v: unknown) => setValues((prev) => ({ ...prev, [code]: v }));

  const save = async () => {
    if (!effectiveType) return setStatus('Выберите узел');
    if (!engineId) return setStatus('Выберите двигатель');
    const atMs = fromDateInput(date);
    if (!atMs) return setStatus('Укажите дату');
    setBusy(true);
    setStatus('');
    try {
      const id = props.row?.id ?? crypto.randomUUID();
      const r = await window.matrica.workSheets.rows.save({
        id,
        engineId,
        type: {
          id: effectiveType.id,
          code: effectiveType.code,
          name: effectiveType.name,
          completesRepair: effectiveType.completesRepair,
          columns: effectiveType.columns,
          workshopId: effectiveType.workshopId,
        },
        atMs,
        workshopId: workshopId || null,
        // Имя цеха — снимком в строку: без него читатель без прав на справочник видит uuid.
        workshopName: props.workshops.find((w) => w.id === workshopId)?.label ?? null,
        note: note.trim() || null,
        values,
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      props.onSaved({ repair: r.repair, typeName: effectiveType.name });
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!props.row) return;
    if (!window.confirm(`Удалить строку «${props.row.typeName}» от ${formatWorkSheetValue({ type: 'date', value: props.row.at })}?`)) return;
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.rows.delete(props.row.id);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      props.onDeleted();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const label = (text: string) => <span style={{ fontSize: 12, color: 'var(--subtle)' }}>{text}</span>;

  return (
    <div
      role="dialog"
      aria-label={editing ? 'Строка ведомости' : 'Новая строка ведомости'}
      data-work-sheet-row-dialog
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(640px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 10 }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>{editing ? `Строка ведомости «${props.row?.typeName}»` : 'Новая строка ведомости'}</div>

        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '8px 10px', alignItems: 'center' }}>
          {label('Узел')}
          <select value={typeCode} disabled={editing} onChange={(e) => setTypeCode(e.target.value)} data-work-sheet-type-select>
            {type === null && effectiveType !== null ? (
              <option value={effectiveType.code}>{effectiveType.name}</option>
            ) : null}
            {props.types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>

          {label('Двигатель')}
          <EntityReferenceField
            target="engine"
            targetLabel="Двигатель"
            value={engineId}
            options={engineOptions}
            optionsReady={props.enginesReady}
            disabled={editing}
            placeholder="Номер двигателя…"
            onChange={(next) => setEngineId(next)}
            {...(props.onOpenEngine ? { onOpen: props.onOpenEngine } : {})}
          />

          {label('Дата')}
          <UnifiedDateInput type="date" value={date} onChange={(e) => setDate(e.target.value)} data-work-sheet-date />

          {label('Цех')}
          <select value={workshopId} onChange={(e) => setWorkshopId(e.target.value)}>
            <option value="">—</option>
            {props.workshops.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>

          {columns.map((col) => (
            <React.Fragment key={col.code}>
              {label(`${col.label}${col.required ? ' *' : ''}`)}
              {col.type === 'boolean' ? (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={values[col.code] === true} onChange={(e) => setValue(col.code, e.target.checked)} />
                  <span className="ui-muted">{WORK_SHEET_COLUMN_TYPE_LABELS.boolean}</span>
                </label>
              ) : col.type === 'date' ? (
                <UnifiedDateInput
                  type="date"
                  value={toDateInput(typeof values[col.code] === 'number' ? (values[col.code] as number) : fromDateInput(String(values[col.code] ?? '')))}
                  onChange={(e) => setValue(col.code, fromDateInput(e.target.value))}
                />
              ) : col.type === 'choice' && (col.options?.length ?? 0) > 0 ? (
                <select value={String(values[col.code] ?? '')} onChange={(e) => setValue(col.code, e.target.value || null)}>
                  <option value="">—</option>
                  {col.options!.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={String(values[col.code] ?? '')}
                  onChange={(e) => setValue(col.code, e.target.value)}
                  placeholder={col.type === 'number' ? 'число' : ''}
                  inputMode={col.type === 'number' ? 'decimal' : undefined}
                />
              )}
            </React.Fragment>
          ))}

          {label('Примечание')}
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {!editing && type?.completesRepair ? (
          <div className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-completes-hint>
            Строка узла «{type.name}» завершает ремонт: в карточке двигателя встанет «Отремонтирован» датой строки.
          </div>
        ) : null}

        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {editing && props.canDelete ? (
            <Button variant="ghost" onClick={remove} disabled={busy} data-work-sheet-row-delete>
              Удалить
            </Button>
          ) : null}
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={save} disabled={busy} data-work-sheet-row-save>
            {busy ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </div>
    </div>
  );
}
