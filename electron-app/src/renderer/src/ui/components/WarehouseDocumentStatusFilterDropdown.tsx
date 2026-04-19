import React, { useEffect, useRef, useState } from 'react';
import {
  WarehouseDocumentStatusLabels,
  WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER,
} from '@matricarmz/shared';

type Props = {
  value: string[];
  onChange: (next: string[]) => void;
};

function summaryText(selected: Set<string>): string {
  const order = WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER;
  if (selected.size === order.length) return 'Все статусы';
  if (selected.size === 0) return 'Ничего не выбрано';
  return order
    .filter((id) => selected.has(id))
    .map((id) => WarehouseDocumentStatusLabels[id] ?? id)
    .join(', ');
}

export function WarehouseDocumentStatusFilterDropdown(props: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = new Set(props.value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onChange(WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER.filter((x) => next.has(x)));
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', minWidth: 200 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '8px 10px',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'var(--panel)',
          color: 'var(--text)',
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        Статусы: {summaryText(selected)}
      </button>
      {open ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '100%',
            marginTop: 4,
            zIndex: 50,
            padding: 10,
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--panel)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER.map((id) => (
            <label
              key={id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                userSelect: 'none',
                fontSize: 14,
              }}
            >
              <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
              {WarehouseDocumentStatusLabels[id] ?? id}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
