import React, { useEffect, useMemo, useState } from 'react';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { openLabelsPrint, type LabelSheetOptions, type LabelTarget } from '../utils/qrLabels.js';

/**
 * Печать QR-этикеток (brain-бэклог #4). Универсальный диалог: получает список
 * кандидатов (номенклатура / складские места), даёт выбрать что печатать, что
 * кодировать (код или id), число колонок и копий, затем открывает окно печати.
 * Полностью офлайн (генерация QR в рендерере).
 */
export function LabelPrintDialog(props: {
  open: boolean;
  title?: string;
  targets: ReadonlyArray<LabelTarget>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [encode, setEncode] = useState<LabelSheetOptions['encode']>('code');
  const [columns, setColumns] = useState(3);
  const [copies, setCopies] = useState(1);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.open) {
      setSelected(new Set(props.targets.map((t) => t.id)));
      setFilter('');
    }
  }, [props.open, props.targets]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return props.targets;
    return props.targets.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        String(t.code ?? '').toLowerCase().includes(q) ||
        String(t.subtitle ?? '').toLowerCase().includes(q),
    );
  }, [props.targets, filter]);

  if (!props.open) return null;

  const toPrint = props.targets.filter((t) => selected.has(t.id));
  const labelCount = toPrint.length * Math.max(1, copies);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setAllFiltered(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const t of filtered) {
        if (on) next.add(t.id);
        else next.delete(t.id);
      }
      return next;
    });
  }

  async function handlePrint() {
    if (toPrint.length === 0) return;
    setBusy(true);
    try {
      await openLabelsPrint(toPrint, { encode, columns, copies });
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
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
          padding: 20,
          borderRadius: 10,
          maxWidth: 'min(96vw, 720px)',
          width: '96vw',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>{props.title ?? 'Печать QR-этикеток'}</h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>Этикеток к печати: {labelCount}</span>
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
          <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
            Кодировать в QR
            <select
              value={encode}
              onChange={(e) => setEncode(e.target.value as LabelSheetOptions['encode'])}
              style={{ padding: '7px 9px' }}
            >
              <option value="code">Код (сканер найдёт по коду/штрихкоду)</option>
              <option value="id">Внутренний id (стабильный)</option>
            </select>
          </label>
          <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3, width: 90 }}>
            Колонок
            <select value={columns} onChange={(e) => setColumns(Number(e.target.value))} style={{ padding: '7px 9px' }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3, width: 90 }}>
            Копий
            <Input
              type="number"
              min={1}
              max={99}
              value={String(copies)}
              onChange={(e) => setCopies(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Фильтр списка…" />
          <Button variant="ghost" size="sm" onClick={() => setAllFiltered(true)}>
            Выбрать все
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAllFiltered(false)}>
            Снять
          </Button>
        </div>

        <div
          style={{
            flex: 1,
            minHeight: 120,
            overflow: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--surface)',
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 14 }}>Нет позиций</div>
          ) : (
            filtered.map((t) => (
              <label
                key={t.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  padding: '5px 10px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                <span style={{ fontWeight: 600 }}>{t.name || '—'}</span>
                {t.code ? <span style={{ color: 'var(--subtle)' }}>· {t.code}</span> : null}
                {t.subtitle ? <span style={{ color: 'var(--subtle)', marginLeft: 'auto', fontSize: 11 }}>{t.subtitle}</span> : null}
              </label>
            ))
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
          <Button onClick={() => void handlePrint()} disabled={busy || labelCount === 0}>
            {busy ? 'Готовлю…' : `Печать (${labelCount})`}
          </Button>
        </div>
      </div>
    </div>
  );
}
