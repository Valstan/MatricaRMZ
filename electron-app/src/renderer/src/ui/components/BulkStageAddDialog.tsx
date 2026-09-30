import React, { useEffect, useState } from 'react';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SearchSelect } from './SearchSelect.js';

type StageTemplate = { code: string; name: string };
type EngineOption = { id: string; label: string };

function toInputDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromInputDate(v: string): number | null {
  const ms = v ? Date.parse(`${v}T12:00:00`) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Массовое добавление этапа на несколько двигателей (PR-D).
 * Оператор выбирает тип этапа, дату, цех и несколько двигателей —
 * этап создаётся у каждого выбранного двигателя.
 */
export function BulkStageAddDialog(props: {
  templates: StageTemplate[];
  workshops: Array<{ id: string; label: string }>;
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}) {
  const [engines, setEngines] = useState<EngineOption[]>([]);
  const [selectedEngineIds, setSelectedEngineIds] = useState<string[]>([]);
  const [stageCode, setStageCode] = useState('');
  const [date, setDate] = useState(toInputDate(Date.now()));
  const [workshopId, setWorkshopId] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await window.matrica.engines.list();
        setEngines(
          rows.map((e) => ({
            id: String(e.id),
            label: e.engineNumber || `Без номера (${String(e.id).slice(0, 8)})`,
          })),
        );
      } catch {
        // Список двигателей не загрузился — оператор может ввести ID вручную
      }
    })();
  }, []);

  const toggleEngine = (id: string) => {
    setSelectedEngineIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const save = async () => {
    if (!stageCode) return setStatus('Выберите этап');
    if (selectedEngineIds.length === 0) return setStatus('Выберите хотя бы один двигатель');
    const atMs = fromInputDate(date);
    if (atMs === null) return setStatus('Укажите дату');

    setBusy(true);
    setStatus('');
    try {
      let ok = 0;
      let fail = 0;
      for (const engineId of selectedEngineIds) {
        const r = await window.matrica.workSheets.stages.save({
          id: crypto.randomUUID(),
          engineId,
          code: stageCode,
          atMs,
          ...(workshopId ? { workshopId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        if (r.ok) ok++;
        else fail++;
      }
      setStatus(`Добавлено: ${ok}${fail > 0 ? `, ошибок: ${fail}` : ''}`);
      await props.onAdded();
      if (fail === 0) {
        setSelectedEngineIds([]);
        setNote('');
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Массовое добавление этапа"
      data-bulk-stage-add
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(700px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 12 }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>Добавить этап на несколько двигателей</div>

        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>Этап</span>
            <select
              value={stageCode}
              disabled={busy}
              data-bulk-stage-code
              onChange={(e) => setStageCode(e.target.value)}
              style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
            >
              <option value="">Выберите этап…</option>
              {props.templates.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="ui-muted" style={{ fontSize: 12 }}>Дата</span>
              <Input type="date" value={date} disabled={busy} data-bulk-stage-date onChange={(e) => setDate(e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="ui-muted" style={{ fontSize: 12 }}>Цех (необязательно)</span>
              <SearchSelect
                value={workshopId}
                options={props.workshops}
                placeholder="—"
                showAllWhenEmpty
                onChange={(next) => setWorkshopId(String(next ?? ''))}
              />
            </label>
          </div>

          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>Примечание (необязательно)</span>
            <Input value={note} disabled={busy} placeholder="Примечание к этапу" onChange={(e) => setNote(e.target.value)} />
          </label>

          <div style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>Двигатели ({selectedEngineIds.length} выбрано)</span>
            <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
              {engines.length === 0 ? (
                <div className="ui-muted" style={{ fontSize: 12 }}>Список двигателей не загрузился</div>
              ) : (
                <div style={{ display: 'grid', gap: 4 }}>
                  {engines.map((e) => (
                    <label key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={selectedEngineIds.includes(e.id)}
                        onChange={() => toggleEngine(e.id)}
                      />
                      <span>{e.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {status ? <div className="ui-muted">{status}</div> : null}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => void save()} disabled={busy || !stageCode || selectedEngineIds.length === 0} data-bulk-stage-save>
            {busy ? 'Добавление…' : `Добавить на ${selectedEngineIds.length || ''} двигателей`}
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
            Закрыть
          </Button>
        </div>
      </div>
    </div>
  );
}
