import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  REPAIR_HISTORY_OPERATION_TYPE,
  buildRepairHistoryMeta,
  repairHistoryActionOptions,
  repairHistoryFromOperations,
  repairHistoryNoteLine,
  type RepairHistoryEntry,
  type RepairHistoryExtraField,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SearchSelect } from './SearchSelect.js';
import { formatMoscowDate } from '../utils/dateUtils.js';

/**
 * История ремонта двигателя (просьба владельца 08.09.2026): что происходило и когда, с
 * возможностью дописать своё.
 *
 * События двух родов, и различие видно оператору: **автоматические** пишет программа при
 * смене стадии и переезде в цех (их правка рассинхронизировала бы историю с карточкой),
 * **ручные** заводит оператор. Хранится всё в `operations` — см. домен `engineRepairHistory`.
 */
export function EngineRepairHistoryPanel(props: {
  engineId: string;
  canEdit: boolean;
  workshopOptions: Array<{ id: string; label: string }>;
  /** Перерисовать карточку после записи — история влияет на строку списка (цех, действие). */
  onChanged?: () => void;
}) {
  const [entries, setEntries] = useState<RepairHistoryEntry[]>([]);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const [draftDate, setDraftDate] = useState('');
  const [draftAction, setDraftAction] = useState('');
  const [draftWorkshopId, setDraftWorkshopId] = useState('');
  const [draftReason, setDraftReason] = useState('');
  const [draftNote, setDraftNote] = useState('');
  const [draftExtra, setDraftExtra] = useState<RepairHistoryExtraField[]>([]);

  const load = useCallback(async () => {
    try {
      const rows = await window.matrica.operations.list(props.engineId);
      setEntries(repairHistoryFromOperations(Array.isArray(rows) ? rows : []));
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.engineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const workshopName = useCallback(
    (id: string) => props.workshopOptions.find((w) => w.id === id)?.label ?? (id ? 'цех не из справочника' : ''),
    [props.workshopOptions],
  );

  const actionOptions = useMemo(() => repairHistoryActionOptions(entries), [entries]);

  function resetDraft() {
    const today = new Date();
    setDraftDate(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`);
    setDraftAction('');
    setDraftWorkshopId('');
    setDraftReason('');
    setDraftNote('');
    setDraftExtra([]);
  }

  async function save() {
    const action = draftAction.trim();
    if (!action) {
      setStatus('Укажите действие — без него строка ничего не говорит');
      return;
    }
    // Дата события — то, что ввёл оператор: строку истории часто заводят задним числом.
    const typed = draftDate ? Date.parse(`${draftDate}T12:00:00`) : Number.NaN;
    const meta = buildRepairHistoryMeta({
      action,
      workshopId: draftWorkshopId,
      reason: draftReason,
      note: draftNote,
      extra: draftExtra,
      ...(Number.isFinite(typed) ? { at: typed } : {}),
    });
    try {
      setStatus('Сохраняю…');
      await window.matrica.operations.add(
        props.engineId,
        REPAIR_HISTORY_OPERATION_TYPE,
        'done',
        repairHistoryNoteLine(meta, workshopName(draftWorkshopId)),
        JSON.stringify(meta),
      );
      setAdding(false);
      resetDraft();
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  return (
    <div data-repair-history style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700 }}>История ремонта</span>
        <span className="ui-muted">{entries.length > 0 ? `${entries.length} событий` : 'событий пока нет'}</span>
        <div style={{ flex: 1 }} />
        {props.canEdit && !adding && (
          <Button
            variant="ghost"
            data-repair-history-add
            onClick={() => {
              resetDraft();
              setAdding(true);
            }}
          >
            Добавить запись
          </Button>
        )}
      </div>

      {adding && (
        <div style={{ display: 'grid', gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ width: 170 }}>
              <Input type="date" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} title="Дата события" data-repair-history-date />
            </div>
            <div style={{ minWidth: 260, flex: 1 }}>
              {/* Список действий ОТКРЫТЫЙ: подсказки через datalist, но ввести можно любое своё —
                  владелец просил не упираться в заранее придуманный набор. */}
              <Input
                value={draftAction}
                onChange={(e) => setDraftAction(e.target.value)}
                placeholder="Действие (можно ввести своё)"
                list="repair-history-actions"
                data-repair-history-action
              />
              <datalist id="repair-history-actions">
                {actionOptions.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </div>
            <div style={{ minWidth: 220 }}>
              <SearchSelect
                value={draftWorkshopId}
                options={props.workshopOptions}
                placeholder="Цех (если применимо)"
                showAllWhenEmpty
                onChange={(next) => setDraftWorkshopId(String(next ?? ''))}
              />
            </div>
          </div>
          <Input value={draftReason} onChange={(e) => setDraftReason(e.target.value)} placeholder="Причина — зачем это сделали" />
          <Input value={draftNote} onChange={(e) => setDraftNote(e.target.value)} placeholder="Примечание — всё, что важно помнить об этом событии" />

          {draftExtra.map((field, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6 }}>
              <div style={{ width: 220 }}>
                <Input
                  value={field.label}
                  placeholder="Название поля"
                  onChange={(e) => setDraftExtra((prev) => prev.map((f, i) => (i === idx ? { ...f, label: e.target.value } : f)))}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Input
                  value={field.value}
                  placeholder="Значение"
                  onChange={(e) => setDraftExtra((prev) => prev.map((f, i) => (i === idx ? { ...f, value: e.target.value } : f)))}
                />
              </div>
              <Button variant="ghost" onClick={() => setDraftExtra((prev) => prev.filter((_, i) => i !== idx))} title="Убрать поле">
                ✕
              </Button>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => setDraftExtra((prev) => [...prev, { label: '', value: '' }])}>
              + поле
            </Button>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Отмена
            </Button>
            <Button onClick={() => void save()} data-repair-history-save>
              Сохранить
            </Button>
          </div>
        </div>
      )}

      {status && <div className="ui-muted">{status}</div>}

      {entries.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Дата', 'Действие', 'Цех', 'Причина', 'Примечание', 'Кто'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} data-repair-history-row={entry.source}>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{formatMoscowDate(new Date(entry.at))}</td>
                  <td style={{ padding: '4px 6px' }}>
                    {entry.action}
                    {/* Пометка нужна: автоматическую запись оператор не правит, и это должно быть видно. */}
                    {entry.source === 'auto' && <span className="ui-muted"> · программа</span>}
                  </td>
                  <td style={{ padding: '4px 6px' }}>{entry.workshopId ? workshopName(entry.workshopId) : ''}</td>
                  <td style={{ padding: '4px 6px' }}>{entry.reason}</td>
                  <td style={{ padding: '4px 6px' }}>
                    {entry.note}
                    {entry.extra.map((f, i) => (
                      <div key={i} className="ui-muted">
                        {f.label}: {f.value}
                      </div>
                    ))}
                  </td>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{entry.performedBy ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
