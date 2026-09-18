import React, { useEffect, useRef, useState } from 'react';
import {
  WarehouseDocumentStatusLabels,
  WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER,
} from '@matricarmz/shared';

import { PopupLayer, useAnchoredPopup } from './PopupLayer.js';

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
  // Отбор статусов стоит в панели фильтров над списком: без портала список
  // перекрывал раскрытые статусы (PopupLayer).
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const popup = useAnchoredPopup(open, anchor, { matchAnchorWidth: true });
  const selected = new Set(props.value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popup.node?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, popup.node]);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.onChange(WAREHOUSE_DOCUMENT_STATUS_FILTER_ORDER.filter((x) => next.has(x)));
  }

  return (
    <div
      ref={(el) => {
        (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        setAnchor(el);
      }}
      style={{ position: 'relative', minWidth: 200 }}
    >
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
        <PopupLayer>
        <div
          ref={popup.ref}
          style={{
            ...popup.style,
            overflowY: 'auto',
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
        </PopupLayer>
      ) : null}
    </div>
  );
}
