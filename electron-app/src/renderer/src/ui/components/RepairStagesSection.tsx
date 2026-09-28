import React, { useCallback, useEffect, useState } from 'react';

import {
  sortStagesByDate,
  type RepairStageRow,
  type RepairStageTemplate,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { formatMoscowDate } from '../utils/dateUtils.js';

// Единый список этапов ремонта (план unified-repair-stages, шаг 4): дата, этап,
// правка дат, новые этапы из шаблона. Ручная галочка дефектовки — это же место:
// этап «Разборка, дефектовка» + дата, без захода в раздел дефектовки.

function toInputDate(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromInputDate(v: string): number | null {
  const ms = v ? Date.parse(`${v}T12:00:00`) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function RepairStagesSection(props: { engineId: string; canEdit: boolean; onChanged?: () => void }) {
  const [templates, setTemplates] = useState<RepairStageTemplate[]>([]);
  const [rows, setRows] = useState<RepairStageRow[]>([]);
  const [status, setStatus] = useState('');
  const [addingCode, setAddingCode] = useState('');
  const [addingDate, setAddingDate] = useState('');
  const [addingNote, setAddingNote] = useState('');
  const [pendingPass, setPendingPass] = useState<{ pass: number; id: string; code: string; atMs: number; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([
        window.matrica.workSheets.stages.templates.list(),
        window.matrica.workSheets.stages.list(props.engineId),
      ]);
      if (t.ok) {
        setTemplates(t.templates);
        if (t.source === 'fallback') setStatus('Шаблон этапов взят из программы — сервер недоступен, свежих правок может не быть.');
      } else setStatus(`Шаблон этапов не загрузился: ${t.error}`);
      if (r.ok) setRows(r.rows);
      else setStatus(`Этапы не загрузились: ${r.error}`);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.engineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sorted = sortStagesByDate(rows);

  async function writeStage(args: { id: string; code: string; atMs: number; note?: string; repeatPass?: number }) {
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.save({ ...args, engineId: props.engineId });
      if (!r.ok && r.duplicate) {
        setPendingPass({ pass: r.duplicate.nextPass, id: args.id, code: args.code, atMs: args.atMs, note: args.note ?? '' });
        setStatus(`Такой этап за этот день уже есть — записать проходом № ${r.duplicate.nextPass}?`);
        return;
      }
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setPendingPass(null);
      setAddingCode('');
      setAddingDate('');
      setAddingNote('');
      setStatus(r.backward ? `«${templateName(args.code)}» — возврат назад, записан проход № ${r.pass}.` : '');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function templateName(code: string): string {
    return templates.find((t) => t.code === code)?.name ?? code;
  }

  async function removeRow(id: string, name: string) {
    if (!confirm(`Убрать этап «${name}» из истории? (строка погасится, не удалится)`)) return;
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.remove(id);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-repair-stages style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700 }}>Этапы ремонта</span>
        <span className="ui-muted">{rows.length > 0 ? `${rows.length}` : 'пока не отмечены'}</span>
      </div>

      {sorted.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Дата', 'Этап', ''].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={row.id} data-repair-stage-row={row.code}>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                    {props.canEdit ? (
                      <Input
                        type="date"
                        value={toInputDate(row.at)}
                        disabled={busy}
                        title="Дата этапа — меняется прямо здесь"
                        data-repair-stage-date={row.id}
                        onChange={(e) => {
                          const atMs = fromInputDate(e.target.value);
                          if (atMs !== null) void writeStage({ id: row.id, code: row.code, atMs });
                        }}
                      />
                    ) : (
                      formatMoscowDate(new Date(row.at ?? 0))
                    )}
                  </td>
                  <td style={{ padding: '4px 6px' }}>
                    {row.name}
                    {row.pass >= 2 && <span className="ui-muted"> · проход № {row.pass} (возврат)</span>}
                    {row.note && <div className="ui-muted">{row.note}</div>}
                  </td>
                  <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                    {props.canEdit && (
                      <Button variant="ghost" disabled={busy} title="Убрать этап" onClick={() => void removeRow(row.id, row.name)}>
                        ✕
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {props.canEdit && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            value={addingCode}
            disabled={busy}
            data-repair-stage-pick
            onChange={(e) => setAddingCode(e.target.value)}
            style={{ minWidth: 220, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
          >
            <option value="">Этап…</option>
            {templates.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
          <div style={{ width: 170 }}>
            <Input type="date" value={addingDate} disabled={busy} title="Дата этапа" data-repair-stage-add-date onChange={(e) => setAddingDate(e.target.value)} />
          </div>
          <div style={{ minWidth: 200, flex: 1 }}>
            <Input value={addingNote} disabled={busy} placeholder="Примечание (необязательно)" onChange={(e) => setAddingNote(e.target.value)} />
          </div>
          <Button
            disabled={busy || !addingCode || !addingDate}
            data-repair-stage-add
            onClick={() => {
              const atMs = fromInputDate(addingDate);
              if (!addingCode || atMs === null) {
                setStatus('Выберите этап и дату');
                return;
              }
              void writeStage({ id: crypto.randomUUID(), code: addingCode, atMs, ...(addingNote.trim() ? { note: addingNote.trim() } : {}) });
            }}
          >
            Отметить этап
          </Button>
        </div>
      )}

      {pendingPass && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            data-repair-stage-confirm-pass
            onClick={() => void writeStage({ id: pendingPass.id, code: pendingPass.code, atMs: pendingPass.atMs, ...(pendingPass.note ? { note: pendingPass.note } : {}), repeatPass: pendingPass.pass })}
          >
            Записать проходом № {pendingPass.pass}
          </Button>
          <Button variant="ghost" onClick={() => { setPendingPass(null); setStatus(''); }}>
            Отмена
          </Button>
        </div>
      )}

      {status && <div className="ui-muted">{status}</div>}
    </div>
  );
}
