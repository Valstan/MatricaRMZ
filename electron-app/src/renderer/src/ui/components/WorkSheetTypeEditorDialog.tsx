import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  WORK_SHEET_COLUMN_TYPES,
  WORK_SHEET_COLUMN_TYPE_LABELS,
  WORK_SHEET_MAX_COLUMNS,
  workSheetCodeFromName,
  type WorkSheetColumn,
  type WorkSheetColumnType,
  type WorkSheetType,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { RowReorderButtons } from './RowReorderButtons.js';
import { loadWorkSheetTypes } from '../utils/workSheetTypesCache.js';
import type { WorkshopOption } from './WorkSheetRowDialog.js';

type Draft = {
  id: string | null;
  code: string;
  name: string;
  workshopId: string;
  completesRepair: boolean;
  columns: WorkSheetColumn[];
  /** Версия узла на момент открытия — с ней сервер сверится, чтобы чужая правка не пропала. */
  updatedAt: number | null;
};

function draftFrom(t: WorkSheetType | null): Draft {
  return t
    ? {
        id: t.id,
        code: t.code,
        name: t.name,
        workshopId: t.workshopId ?? '',
        completesRepair: t.completesRepair,
        columns: t.columns.map((c) => ({ ...c })),
        updatedAt: t.updatedAt,
      }
    : { id: null, code: '', name: '', workshopId: '', completesRepair: false, columns: [], updatedAt: null };
}

/**
 * Редактор узлов: название, цех, «строка завершает ремонт» и набор колонок (подпись, тип,
 * обязательность, варианты). Код узла и код колонки после создания заморожены — на них ссылаются
 * строки истории. Новая колонка попадает в фильтры и отчёты сама: строка несёт поля с собой.
 */
export function WorkSheetTypeEditorDialog(props: {
  types: WorkSheetType[];
  initialTypeCode: string | null;
  workshops: WorkshopOption[];
  onClose: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const [selectedCode, setSelectedCode] = useState<string | null>(props.initialTypeCode ?? props.types[0]?.code ?? null);
  const selected = useMemo(() => props.types.find((t) => t.code === selectedCode) ?? null, [props.types, selectedCode]);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(props.types.find((t) => t.code === (props.initialTypeCode ?? props.types[0]?.code)) ?? null));
  const [newColLabel, setNewColLabel] = useState('');
  const [newColType, setNewColType] = useState<WorkSheetColumnType>('text');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // Архивные узлы экран не показывает, но редактор обязан: иначе архив — дверь в одну
  // сторону, а код узла занят навсегда (на него ссылаются строки).
  const [archived, setArchived] = useState<WorkSheetType[]>([]);
  const refreshArchived = useCallback(async () => {
    const res = await loadWorkSheetTypes({ includeArchived: true });
    setArchived(res.rows.filter((t) => t.archivedAt != null));
  }, []);
  useEffect(() => {
    void refreshArchived();
  }, [refreshArchived]);

  const pick = (t: WorkSheetType | null) => {
    setSelectedCode(t?.code ?? null);
    setDraft(draftFrom(t));
    setStatus('');
  };

  const patchCol = (i: number, patch: Partial<WorkSheetColumn>) =>
    setDraft((d) => ({ ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));
  const setRequired = (i: number, required: boolean) =>
    setDraft((d) => ({
      ...d,
      columns: d.columns.map((c, j) => {
        if (j !== i) return c;
        const { required: _drop, ...rest } = c;
        return required ? { ...rest, required: true } : rest;
      }),
    }));
  const moveCol = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const next = [...d.columns];
      const j = i + dir;
      if (j < 0 || j >= next.length) return d;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...d, columns: next };
    });
  const addCol = () => {
    const label = newColLabel.trim();
    if (!label) return;
    const base = workSheetCodeFromName(label);
    if (!base) return setStatus('Из такой подписи код не собрать — добавьте буквы');
    let code = base;
    let n = 2;
    while (draft.columns.some((c) => c.code === code)) code = `${base}_${n++}`.slice(0, 40);
    if (draft.columns.length >= WORK_SHEET_MAX_COLUMNS) return setStatus(`Не больше ${WORK_SHEET_MAX_COLUMNS} колонок`);
    setDraft((d) => ({ ...d, columns: [...d.columns, { code, label, type: newColType, ...(newColType === 'choice' ? { options: [] } : {}) }] }));
    setNewColLabel('');
    setStatus('');
  };

  const save = async () => {
    if (!draft.name.trim()) return setStatus('Название узла обязательно');
    setBusy(true);
    setStatus('');
    try {
      const r = await window.matrica.workSheets.types.upsert({
        ...(draft.id ? { id: draft.id } : {}),
        ...(draft.id ? {} : draft.code.trim() ? { code: draft.code.trim() } : {}),
        name: draft.name.trim(),
        workshopId: draft.workshopId || null,
        completesRepair: draft.completesRepair,
        columns: draft.columns,
        ...(draft.id && draft.updatedAt != null ? { expectedUpdatedAt: draft.updatedAt } : {}),
      });
      if (!r.ok) return setStatus(`Ошибка: ${r.error}`);
      await props.onChanged();
      pick(r.row);
      setStatus('Сохранено');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (t: WorkSheetType) => {
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.types.restore(t.id);
      if (!r.ok) return setStatus(`Ошибка: ${r.error}`);
      await props.onChanged();
      await refreshArchived();
      setStatus(`Узел «${t.name}» возвращён из архива`);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!selected) return;
    if (!window.confirm(`Убрать узел «${selected.name}» в архив? Его строки в истории останутся.`)) return;
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.types.archive(selected.id);
      if (!r.ok) return setStatus(`Ошибка: ${r.error}`);
      await props.onChanged();
      await refreshArchived();
      pick(null);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Узлы ведомостей работ"
      data-work-sheet-type-editor
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(900px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gridTemplateColumns: '220px 1fr', gap: 14 }}
      >
        <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
          <div style={{ fontWeight: 700 }}>Узлы</div>
          {props.types.map((t) => (
            <button
              key={t.code}
              type="button"
              onClick={() => pick(t)}
              style={{ textAlign: 'left', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)', background: t.code === selectedCode ? 'rgba(59,130,246,0.12)' : 'transparent', cursor: 'pointer' }}
            >
              {t.name}
              {t.completesRepair ? <span className="ui-muted"> · завершает ремонт</span> : null}
            </button>
          ))}
          <Button variant="ghost" onClick={() => pick(null)} data-work-sheet-type-new>
            + Новый узел
          </Button>

          {archived.length > 0 ? (
            <div style={{ display: 'grid', gap: 6, marginTop: 10 }} data-work-sheet-type-archived>
              <div className="ui-muted" style={{ fontSize: 12 }}>В архиве — строки остались, код занят</div>
              {archived.map((t) => (
                <div key={t.code} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="ui-muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                  <Button variant="ghost" disabled={busy} onClick={() => void restore(t)} title="Вернуть узел из архива">
                    Вернуть
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{draft.id ? `Узел «${selected?.name ?? ''}»` : 'Новый узел'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '8px 10px', alignItems: 'center' }}>
            <span className="ui-muted">Название</span>
            <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} data-work-sheet-type-name />
            <span className="ui-muted">Код</span>
            {draft.id ? (
              <span title="Код заморожен: на него ссылаются строки истории">{draft.code}</span>
            ) : (
              <Input value={draft.code} placeholder={workSheetCodeFromName(draft.name) || 'из названия'} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))} />
            )}
            <span className="ui-muted">Цех</span>
            <select value={draft.workshopId} onChange={(e) => setDraft((d) => ({ ...d, workshopId: e.target.value }))}>
              <option value="">—</option>
              {props.workshops.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
            <span className="ui-muted">Завершает ремонт</span>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={draft.completesRepair} onChange={(e) => setDraft((d) => ({ ...d, completesRepair: e.target.checked }))} data-work-sheet-type-completes />
              <span className="ui-muted">строка ставит «Отремонтирован» датой строки</span>
            </label>
          </div>

          <div style={{ fontWeight: 600 }}>Колонки узла</div>
          {draft.columns.length === 0 ? <div className="ui-muted">Пока только общие: дата, двигатель, цех, исполнитель, примечание.</div> : null}
          {draft.columns.map((c, i) => (
            <div key={c.code} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 150px auto auto', gap: 8, alignItems: 'center' }} data-work-sheet-column={c.code}>
              <RowReorderButtons canMoveUp={i > 0} canMoveDown={i < draft.columns.length - 1} onMoveUp={() => moveCol(i, -1)} onMoveDown={() => moveCol(i, 1)} />
              <Input value={c.label} onChange={(e) => patchCol(i, { label: e.target.value })} title={`код: ${c.code}`} />
              <select value={c.type} onChange={(e) => patchCol(i, { type: e.target.value as WorkSheetColumnType })}>
                {WORK_SHEET_COLUMN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {WORK_SHEET_COLUMN_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={c.required === true} onChange={(e) => setRequired(i, e.target.checked)} />
                <span className="ui-muted">обяз.</span>
              </label>
              <Button variant="ghost" onClick={() => setDraft((d) => ({ ...d, columns: d.columns.filter((_, j) => j !== i) }))} title="Убрать колонку">
                ✕
              </Button>
              {c.type === 'choice' ? (
                <div style={{ gridColumn: '2 / -1' }}>
                  <Input
                    value={(c.options ?? []).join(', ')}
                    placeholder="Варианты через запятую"
                    onChange={(e) => patchCol(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                  />
                </div>
              ) : null}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input value={newColLabel} placeholder="Подпись новой колонки" onChange={(e) => setNewColLabel(e.target.value)} data-work-sheet-new-column />
            <select value={newColType} onChange={(e) => setNewColType(e.target.value as WorkSheetColumnType)}>
              {WORK_SHEET_COLUMN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {WORK_SHEET_COLUMN_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <Button variant="ghost" onClick={addCol}>
              + Колонка
            </Button>
          </div>

          {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

          <div style={{ display: 'flex', gap: 8 }}>
            {selected ? (
              <Button variant="ghost" onClick={archive} disabled={busy}>
                В архив
              </Button>
            ) : null}
            <div style={{ flex: 1 }} />
            <Button variant="ghost" onClick={props.onClose} disabled={busy}>
              Закрыть
            </Button>
            <Button onClick={save} disabled={busy} data-work-sheet-type-save>
              {busy ? 'Сохранение…' : 'Сохранить узел'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
