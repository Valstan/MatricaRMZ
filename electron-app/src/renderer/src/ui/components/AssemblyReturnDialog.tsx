import React, { useEffect, useMemo, useState } from 'react';

import { AssemblyReturnMode, ASSEMBLY_RETURN_MODE_LABELS } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

type NomenclatureOption = { id: string; label: string; code: string };

type Line = {
  id: string;
  nomenclatureId: string;
  qty: number;
  mode: 'rework' | 'scrap';
};

function freshLine(): Line {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, nomenclatureId: '', qty: 1, mode: AssemblyReturnMode.Rework };
}

export function AssemblyReturnDialog(props: {
  open: boolean;
  onClose: () => void;
  engineId: string;
  engineLabel: string;
  onComplete?: (result: { documentId: string }) => void;
}) {
  const [lines, setLines] = useState<Line[]>([freshLine()]);
  const [reason, setReason] = useState('');
  const [nomen, setNomen] = useState<NomenclatureOption[]>([]);
  const [nomenLoading, setNomenLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    setLines([freshLine()]);
    setReason('');
    setStatus('');
  }, [props.open, props.engineId]);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setNomenLoading(true);
    (async () => {
      try {
        const r = await window.matrica.warehouse.nomenclatureList({ limit: 5000 });
        if (cancelled) return;
        if (r?.ok && Array.isArray(r.rows)) {
          const opts: NomenclatureOption[] = r.rows
            .map((row: Record<string, unknown>) => ({
              id: String(row.id ?? ''),
              code: String(row.code ?? ''),
              label: String(row.name ?? ''),
            }))
            .filter((o) => o.id);
          setNomen(opts);
        }
      } finally {
        if (!cancelled) setNomenLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.open]);

  const totalQty = useMemo(() => lines.reduce((acc, l) => acc + Math.max(0, l.qty), 0), [lines]);

  if (!props.open) return null;

  function addLine() {
    setLines((prev) => [...prev, freshLine()]);
  }
  function patchLine(id: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }
  function removeLine(id: string) {
    setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.id !== id)));
  }

  async function submit() {
    setStatus('');
    const ready = lines
      .filter((l) => l.nomenclatureId && l.qty > 0)
      .map((l) => ({ nomenclatureId: l.nomenclatureId, qty: Math.trunc(l.qty), mode: l.mode }));
    if (ready.length === 0) {
      setStatus('Заполните хотя бы одну строку (деталь + qty > 0)');
      return;
    }
    setSubmitting(true);
    try {
      const r = await window.matrica.workOrders.assemblyReturn({
        engineId: props.engineId,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        lines: ready,
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      props.onComplete?.({ documentId: r.documentId });
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          padding: 16,
          borderRadius: 8,
          maxWidth: 'min(96vw, 880px)',
          width: '96vw',
          maxHeight: '88vh',
          overflow: 'auto',
          border: '1px solid var(--border)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Возврат деталей из сборки</h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>двигатель: {props.engineLabel}</span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Причина:</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Например: обнаружен брак при контрольной сборке"
            style={{ flex: 1 }}
          />
        </div>

        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Деталь</th>
              <th style={{ width: 100 }}>Кол-во</th>
              <th style={{ width: 160 }}>Куда</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <select
                    value={line.nomenclatureId}
                    onChange={(e) => patchLine(line.id, { nomenclatureId: e.target.value })}
                    style={{ width: '100%', padding: '4px 6px' }}
                  >
                    <option value="">{nomenLoading ? 'Загрузка…' : '— выберите деталь —'}</option>
                    {nomen.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label} {o.code ? `(${o.code})` : ''}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <Input
                    type="number"
                    value={String(line.qty)}
                    onChange={(e) => patchLine(line.id, { qty: Math.max(0, Number(e.target.value) || 0) })}
                    style={{ width: 90, textAlign: 'right' }}
                  />
                </td>
                <td>
                  <select
                    value={line.mode}
                    onChange={(e) =>
                      patchLine(line.id, {
                        mode: e.target.value === AssemblyReturnMode.Scrap ? AssemblyReturnMode.Scrap : AssemblyReturnMode.Rework,
                      })
                    }
                    style={{ width: '100%', padding: '4px 6px' }}
                  >
                    <option value={AssemblyReturnMode.Rework}>{ASSEMBLY_RETURN_MODE_LABELS[AssemblyReturnMode.Rework]} (в ремфонд)</option>
                    <option value={AssemblyReturnMode.Scrap}>{ASSEMBLY_RETURN_MODE_LABELS[AssemblyReturnMode.Scrap]} (в утиль)</option>
                  </select>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <Button variant="ghost" onClick={() => removeLine(line.id)} disabled={lines.length <= 1}>
                    ✕
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 8 }}>
          <Button variant="ghost" onClick={addLine}>+ строка</Button>
          <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--subtle)' }}>
            Σ qty: {totalQty}
          </span>
        </div>

        {status ? (
          <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 13 }}>{status}</div>
        ) : null}

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={props.onClose}>Отмена</Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Отправляю…' : 'Провести возврат'}
          </Button>
        </div>
      </div>
    </div>
  );
}
