import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type ListContextMenuItem = {
  id: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
};

export function ListContextMenu(props: {
  x: number;
  y: number;
  items: ListContextMenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const padding = 8;
    const rect = el.getBoundingClientRect();
    let left = props.x;
    let top = props.y;
    if (left + rect.width > window.innerWidth - padding) left = window.innerWidth - padding - rect.width;
    if (left < padding) left = padding;
    if (top + rect.height > window.innerHeight - padding) top = window.innerHeight - padding - rect.height;
    if (top < padding) top = padding;
    setPos({ left, top });
  }, [props.x, props.y, props.items]);

  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      props.onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('mousedown', onDocDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDocDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [props]);

  return (
    <div
      ref={menuRef}
      data-list-context-menu="true"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 13000,
        minWidth: 240,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--chat-menu-shadow)',
        padding: 6,
      }}
    >
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onClick();
            props.onClose();
          }}
          style={{
            width: '100%',
            textAlign: 'left',
            border: '1px solid transparent',
            background: 'transparent',
            color: item.danger ? 'var(--danger)' : 'var(--text)',
            padding: '8px 10px',
            cursor: item.disabled ? 'default' : 'pointer',
            opacity: item.disabled ? 0.55 : 1,
            fontSize: 13,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

