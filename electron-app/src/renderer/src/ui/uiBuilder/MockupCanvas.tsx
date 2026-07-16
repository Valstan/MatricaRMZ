import React, { useRef } from 'react';
import {
  MOCK_BLOCK_LABELS_RU,
  MOCK_BLOCK_MIN_SIZE,
  orderBlocksForReading,
  type MockBlock,
  type MockLink,
  type MockLinkKind,
  type UiSpecV2,
} from '@matricarmz/shared';

import { theme } from '../theme.js';

export type MockupSelection = { type: 'block' | 'link'; id: string } | null;

/** Sketch look: everything muted/dashed so nobody mistakes the mockup for a working UI. */
const sketch = {
  border: '#9aa3ad',
  fill: 'rgba(125,125,125,0.06)',
  fillStrong: 'rgba(125,125,125,0.14)',
  text: theme.colors.text,
  muted: theme.colors.muted,
  selected: '#4a90d9',
  noteBg: 'rgba(235, 200, 80, 0.25)',
  noteBorder: '#c9a227',
};

export const MOCK_LINK_STYLES: Record<MockLinkKind, { stroke: string; dash?: string }> = {
  navigate: { stroke: '#4a90d9' },
  data: { stroke: '#3fa060', dash: '7 5' },
  filter: { stroke: '#b06fc9', dash: '10 4 2 4' },
  other: { stroke: '#9aa3ad', dash: '3 4' },
};

function GreyLines(props: { count: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, overflow: 'hidden', flex: 1, minHeight: 0 }}>
      {Array.from({ length: props.count }, (_, i) => (
        <div key={i} style={{ height: 9, borderRadius: 4, background: sketch.fillStrong, width: `${92 - ((i * 17) % 30)}%` }} />
      ))}
    </div>
  );
}

function BlockBody(props: { block: MockBlock }) {
  const b = props.block;
  const label = b.label?.trim() || '';
  switch (b.kind) {
    case 'heading':
      return (
        <div style={{ fontSize: Math.min(22, Math.max(14, b.h - 22)), fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label || 'Заголовок'}
        </div>
      );
    case 'text':
      return label ? (
        <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflow: 'hidden' }}>{label}</div>
      ) : (
        <GreyLines count={Math.max(2, Math.floor((b.h - 16) / 16))} />
      );
    case 'button':
      return (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: `1.5px solid ${sketch.border}`,
            borderRadius: 8,
            background: sketch.fillStrong,
            fontSize: 13,
            fontWeight: 600,
            overflow: 'hidden',
          }}
        >
          {label || 'Кнопка'}
        </div>
      );
    case 'input':
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', border: `1px solid ${sketch.border}`, borderRadius: 6, padding: '0 8px', fontSize: 13, color: sketch.muted, background: 'transparent', overflow: 'hidden' }}>
          {label || 'Поле ввода…'}
        </div>
      );
    case 'select':
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', border: `1px solid ${sketch.border}`, borderRadius: 6, padding: '0 8px', fontSize: 13, color: sketch.muted, overflow: 'hidden' }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || 'Выбор…'}</span>
          <span>▾</span>
        </div>
      );
    case 'checkbox':
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, overflow: 'hidden' }}>
          <span style={{ width: 16, height: 16, border: `1.5px solid ${sketch.border}`, borderRadius: 3, flex: '0 0 auto' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || 'Галочка'}</span>
        </div>
      );
    case 'date':
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${sketch.border}`, borderRadius: 6, padding: '0 8px', fontSize: 13, color: sketch.muted, overflow: 'hidden' }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label || 'дд.мм.гггг'}</span>
          <span>📅</span>
        </div>
      );
    case 'table': {
      const cols = b.items && b.items.length > 0 ? b.items : ['Колонка 1', 'Колонка 2'];
      const rows = Math.max(1, Math.floor((b.h - 58) / 24));
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: `1px solid ${sketch.border}`, borderRadius: 6, overflow: 'hidden', fontSize: 12 }}>
          <div style={{ display: 'flex', background: sketch.fillStrong, fontWeight: 600 }}>
            {cols.map((c, i) => (
              <div key={i} style={{ flex: 1, padding: '4px 6px', borderRight: i < cols.length - 1 ? `1px solid ${sketch.border}` : 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c}
              </div>
            ))}
          </div>
          {Array.from({ length: rows }, (_, r) => (
            <div key={r} style={{ display: 'flex', borderTop: `1px solid ${sketch.fillStrong}` }}>
              {cols.map((_, i) => (
                <div key={i} style={{ flex: 1, padding: '4px 6px' }}>
                  <div style={{ height: 8, borderRadius: 4, background: sketch.fill, width: `${85 - ((r * 13 + i * 29) % 35)}%` }} />
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    }
    case 'list':
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, border: `1px solid ${sketch.border}`, borderRadius: 6, padding: 8, overflow: 'hidden' }}>
          {label ? <div style={{ fontSize: 12, fontWeight: 600 }}>{label}</div> : null}
          <GreyLines count={Math.max(2, Math.floor((b.h - (label ? 40 : 20)) / 17))} />
        </div>
      );
    case 'panel':
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: sketch.muted, marginBottom: 4 }}>{label || 'Панель'}</div>
        </div>
      );
    case 'tabs': {
      const tabs = b.items && b.items.length > 0 ? b.items : ['Вкладка 1', 'Вкладка 2'];
      return (
        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 4, overflow: 'hidden' }}>
          {tabs.map((t, i) => (
            <div
              key={i}
              style={{
                padding: '5px 12px',
                fontSize: 12,
                border: `1px solid ${sketch.border}`,
                borderBottom: 'none',
                borderRadius: '6px 6px 0 0',
                background: i === 0 ? sketch.fillStrong : 'transparent',
                fontWeight: i === 0 ? 600 : 400,
                whiteSpace: 'nowrap',
              }}
            >
              {t}
            </div>
          ))}
          <div style={{ flex: 1, borderBottom: `1px solid ${sketch.border}` }} />
        </div>
      );
    }
    case 'image':
      return (
        <div style={{ flex: 1, position: 'relative', border: `1px solid ${sketch.border}`, borderRadius: 6, overflow: 'hidden' }}>
          <svg width="100%" height="100%" preserveAspectRatio="none">
            <line x1="0" y1="0" x2="100%" y2="100%" stroke={sketch.border} strokeWidth={1} />
            <line x1="100%" y1="0" x2="0" y2="100%" stroke={sketch.border} strokeWidth={1} />
          </svg>
          {label ? (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: sketch.muted }}>{label}</div>
          ) : null}
        </div>
      );
    case 'note':
      return (
        <div style={{ flex: 1, fontSize: 12, whiteSpace: 'pre-wrap', overflow: 'hidden' }}>
          {label || b.note?.trim() || 'Заметка…'}
        </div>
      );
  }
}

function edgeAnchor(from: MockBlock, to: MockBlock): { x1: number; y1: number; x2: number; y2: number } {
  const cx1 = from.x + from.w / 2;
  const cy1 = from.y + from.h / 2;
  const cx2 = to.x + to.w / 2;
  const cy2 = to.y + to.h / 2;
  const clip = (b: MockBlock, cx: number, cy: number, tx: number, ty: number) => {
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const sx = dx !== 0 ? b.w / 2 / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? b.h / 2 / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  };
  const p1 = clip(from, cx1, cy1, cx2, cy2);
  const p2 = clip(to, cx2, cy2, cx1, cy1);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

function LinksLayer(props: {
  spec: UiSpecV2;
  selection: MockupSelection;
  onSelectLink?: ((id: string) => void) | undefined;
}) {
  const byId = new Map(props.spec.blocks.map((b) => [b.id, b]));
  return (
    <svg
      width={props.spec.canvas.w}
      height={props.spec.canvas.h}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      <defs>
        {(Object.keys(MOCK_LINK_STYLES) as MockLinkKind[]).map((k) => (
          <marker key={k} id={`mock-arrow-${k}`} markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
            <path d="M0,0 L10,4 L0,8 z" fill={MOCK_LINK_STYLES[k].stroke} />
          </marker>
        ))}
      </defs>
      {props.spec.links.map((l: MockLink) => {
        const from = byId.get(l.fromId);
        const to = byId.get(l.toId);
        if (!from || !to) return null;
        const { x1, y1, x2, y2 } = edgeAnchor(from, to);
        const style = MOCK_LINK_STYLES[l.kind];
        const selected = props.selection?.type === 'link' && props.selection.id === l.id;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        return (
          <g key={l.id}>
            {/* invisible fat line to make thin links clickable */}
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="transparent"
              strokeWidth={12}
              style={{ pointerEvents: props.onSelectLink ? 'stroke' : 'none', cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                props.onSelectLink?.(l.id);
              }}
            />
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={style.stroke}
              strokeWidth={selected ? 3 : 1.8}
              strokeDasharray={style.dash}
              markerEnd={`url(#mock-arrow-${l.kind})`}
            />
            {l.label ? (
              <text
                x={mx}
                y={my - 6}
                textAnchor="middle"
                style={{ fontSize: 11, fill: style.stroke, paintOrder: 'stroke', stroke: 'var(--panel, #fff)', strokeWidth: 3 }}
              >
                {l.label}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Free-canvas mockup renderer + (in edit mode) drag/resize/link interactions.
 * Pure visualization: blocks are sketch placeholders, nothing executes.
 */
export function MockupCanvas(props: {
  spec: UiSpecV2;
  mode: 'view' | 'edit';
  selection?: MockupSelection;
  showAnnotations?: boolean;
  /** Link-creation mode: block clicks go to onLinkClick instead of select/drag. */
  linkMode?: boolean;
  linkFromId?: string | null;
  onSelect?: (sel: MockupSelection) => void;
  onLinkClick?: (blockId: string) => void;
  onBlockGeometry?: (id: string, patch: { x?: number; y?: number; w?: number; h?: number }) => void;
}) {
  const { spec, mode } = props;
  const selection = props.selection ?? null;
  const editable = mode === 'edit';
  const dragRef = useRef<{
    id: string;
    kind: 'move' | 'resize';
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    origW: number;
    origH: number;
  } | null>(null);

  const annotationNums = new Map<string, number>();
  if (props.showAnnotations) {
    orderBlocksForReading(spec.blocks).forEach((b, i) => annotationNums.set(b.id, i + 1));
  }

  function startDrag(e: React.PointerEvent, b: MockBlock, kind: 'move' | 'resize') {
    if (!editable || props.linkMode) return;
    e.stopPropagation();
    e.preventDefault();
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      // synthetic/expired pointerId — dragging still works via canvas onPointerMove
    }
    dragRef.current = { id: b.id, kind, startX: e.clientX, startY: e.clientY, origX: b.x, origY: b.y, origW: b.w, origH: b.h };
    props.onSelect?.({ type: 'block', id: b.id });
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.kind === 'move') {
      props.onBlockGeometry?.(d.id, {
        x: Math.max(0, Math.min(spec.canvas.w - MOCK_BLOCK_MIN_SIZE, d.origX + dx)),
        y: Math.max(0, Math.min(spec.canvas.h - MOCK_BLOCK_MIN_SIZE, d.origY + dy)),
      });
    } else {
      props.onBlockGeometry?.(d.id, {
        w: Math.max(MOCK_BLOCK_MIN_SIZE, d.origW + dx),
        h: Math.max(MOCK_BLOCK_MIN_SIZE, d.origH + dy),
      });
    }
  }

  function endDrag() {
    dragRef.current = null;
  }

  // Panels behind everything, then reading order — so overlapping blocks stay reachable.
  const zOrdered = [...spec.blocks].sort((a, b) => (a.kind === 'panel' ? 0 : 1) - (b.kind === 'panel' ? 0 : 1));

  return (
    <div
      style={{
        position: 'relative',
        width: spec.canvas.w,
        height: spec.canvas.h,
        background:
          'repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(125,125,125,0.055) 23px, rgba(125,125,125,0.055) 24px), repeating-linear-gradient(90deg, transparent, transparent 23px, rgba(125,125,125,0.055) 23px, rgba(125,125,125,0.055) 24px)',
        border: `1px solid ${theme.colors.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        cursor: props.linkMode ? 'crosshair' : 'default',
      }}
      onPointerMove={editable ? onPointerMove : undefined}
      onPointerUp={editable ? endDrag : undefined}
      onPointerLeave={editable ? endDrag : undefined}
      onClick={() => props.onSelect?.(null)}
    >
      <LinksLayer spec={spec} selection={selection} onSelectLink={props.onSelect ? (id) => props.onSelect?.({ type: 'link', id }) : undefined} />
      {zOrdered.map((b) => {
        const selected = selection?.type === 'block' && selection.id === b.id;
        const isLinkSource = props.linkFromId === b.id;
        const num = annotationNums.get(b.id);
        const isNote = b.kind === 'note';
        return (
          <div
            key={b.id}
            title={b.note?.trim() ? b.note : undefined}
            style={{
              position: 'absolute',
              left: b.x,
              top: b.y,
              width: b.w,
              height: b.h,
              display: 'flex',
              flexDirection: 'column',
              padding: b.kind === 'panel' ? 8 : 4,
              boxSizing: 'border-box',
              border: isNote
                ? `1px solid ${sketch.noteBorder}`
                : b.kind === 'panel'
                  ? `1.5px dashed ${selected || isLinkSource ? sketch.selected : sketch.border}`
                  : `1px ${selected || isLinkSource ? 'solid' : 'dashed'} ${selected || isLinkSource ? sketch.selected : 'transparent'}`,
              borderRadius: 8,
              background: isNote ? sketch.noteBg : b.kind === 'panel' ? sketch.fill : 'transparent',
              boxShadow: selected ? `0 0 0 2px ${sketch.selected}44` : isLinkSource ? `0 0 0 2px ${sketch.selected}88` : 'none',
              color: sketch.text,
              cursor: props.linkMode ? 'crosshair' : editable ? 'move' : 'default',
              userSelect: 'none',
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (props.linkMode) props.onLinkClick?.(b.id);
              else props.onSelect?.({ type: 'block', id: b.id });
            }}
            onPointerDown={(e) => startDrag(e, b, 'move')}
          >
            <BlockBody block={b} />
            {num != null ? (
              <span
                style={{
                  position: 'absolute',
                  top: -9,
                  left: -9,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: sketch.selected,
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {num}
              </span>
            ) : null}
            {b.note?.trim() && !props.showAnnotations ? (
              <span style={{ position: 'absolute', top: -7, right: -7, fontSize: 12 }} title={b.note}>
                💬
              </span>
            ) : null}
            {editable && selected && !props.linkMode ? (
              <span
                onPointerDown={(e) => startDrag(e, b, 'resize')}
                style={{
                  position: 'absolute',
                  right: -6,
                  bottom: -6,
                  width: 14,
                  height: 14,
                  borderRadius: 4,
                  background: sketch.selected,
                  cursor: 'nwse-resize',
                }}
                title="Растянуть"
              />
            ) : null}
          </div>
        );
      })}
      {spec.blocks.length === 0 ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: sketch.muted, fontSize: 14 }}>
          Холст пуст — добавьте элементы из палитры слева.
        </div>
      ) : null}
    </div>
  );
}

export { MOCK_BLOCK_LABELS_RU };
