import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from './Button.js';

export type ColumnDescriptor = {
  id: string;
  label: string;
  alwaysVisible?: boolean;
};

export function ColumnSettingsButton(props: {
  columns: ColumnDescriptor[];
  order: string[];
  isVisible: (id: string) => boolean;
  onToggleVisible: (id: string, visible: boolean) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: PointerEvent) {
      if (!containerRef.current) return;
      const target = ev.target as Node | null;
      if (target && containerRef.current.contains(target)) return;
      close();
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') close();
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const byId = new Map(props.columns.map((c) => [c.id, c]));
  const orderedDescriptors = props.order
    .map((id) => byId.get(id))
    .filter((c): c is ColumnDescriptor => Boolean(c));
  const visibleCount = orderedDescriptors.filter((c) => props.isVisible(c.id)).length;
  const totalCount = orderedDescriptors.length;

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <Button
        variant="ghost"
        onClick={() => setOpen((v) => !v)}
        title="Настройка колонок списка"
        style={{ whiteSpace: 'nowrap' }}
      >
        Колонки: {visibleCount}/{totalCount}
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Настройка колонок"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 50,
            minWidth: 320,
            maxHeight: 480,
            overflowY: 'auto',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
            padding: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 8px' }}>
            <span style={{ fontWeight: 700 }}>Колонки списка</span>
            <Button variant="ghost" onClick={props.onReset} title="Восстановить набор по умолчанию">
              Сбросить
            </Button>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {orderedDescriptors.map((col, idx) => {
              const visible = props.isVisible(col.id);
              const disableHide = col.alwaysVisible === true;
              return (
                <li
                  key={col.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 8px',
                    borderTop: idx === 0 ? '1px solid var(--border)' : 'none',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={visible}
                    disabled={disableHide}
                    onChange={(e) => props.onToggleVisible(col.id, e.target.checked)}
                    title={disableHide ? 'Эту колонку нельзя скрыть' : visible ? 'Скрыть колонку' : 'Показать колонку'}
                  />
                  <span style={{ flex: 1, opacity: visible ? 1 : 0.55 }}>{col.label}</span>
                  <Button
                    variant="ghost"
                    onClick={() => props.onMove(col.id, -1)}
                    title="Переместить выше"
                    disabled={idx === 0}
                    style={{ padding: '2px 8px', minWidth: 0 }}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => props.onMove(col.id, 1)}
                    title="Переместить ниже"
                    disabled={idx === orderedDescriptors.length - 1}
                    style={{ padding: '2px 8px', minWidth: 0 }}
                  >
                    ↓
                  </Button>
                </li>
              );
            })}
          </ul>
          <div style={{ padding: '8px', fontSize: 12, color: 'var(--muted)' }}>
            Перемещайте колонки стрелками ↑/↓. Снимите галочку, чтобы скрыть колонку.
          </div>
        </div>
      )}
    </div>
  );
}
