import React, { useEffect, useState } from 'react';
import type { EngineListItem, UiListWidgetId } from '@matricarmz/shared';
import { UI_LIST_WIDGET_DEFAULT_LIMIT, UI_LIST_WIDGET_LABELS_RU } from '@matricarmz/shared';

import { theme } from '../theme.js';
import type { UiIntentRuntime } from './intentRuntime.js';

type WorkOrderRow = {
  id: string;
  workOrderNumber: number;
  orderDate: number;
  workType: string;
  engineBrand: string;
  engineNumber: string;
  status: string;
};

type WidgetState<T> = { kind: 'loading' } | { kind: 'denied' } | { kind: 'ready'; rows: T[] };

function fmtDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

const widgetBox: React.CSSProperties = {
  border: `1px solid ${theme.colors.border}`,
  borderRadius: 8,
  overflow: 'hidden',
};
const widgetTitle: React.CSSProperties = {
  padding: '6px 10px',
  fontWeight: 600,
  fontSize: 13,
  borderBottom: `1px solid ${theme.colors.border}`,
};
const rowStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '5px 10px',
  fontSize: 13,
  background: 'transparent',
  border: 'none',
  borderBottom: `1px solid ${theme.colors.border}`,
  color: theme.colors.text,
  cursor: 'pointer',
};
const mutedNote: React.CSSProperties = { padding: '8px 10px', fontSize: 13, color: theme.colors.muted };

function WidgetFrame(props: { widget: UiListWidgetId; children: React.ReactNode }) {
  return (
    <div style={widgetBox}>
      <div style={widgetTitle}>{UI_LIST_WIDGET_LABELS_RU[props.widget]}</div>
      {props.children}
    </div>
  );
}

function RecentEnginesWidget(props: { limit: number; runtime: UiIntentRuntime }) {
  const [state, setState] = useState<WidgetState<EngineListItem>>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = (await window.matrica.engines.list()) as EngineListItem[] | { ok: false };
        if (!alive) return;
        if (!Array.isArray(rows)) {
          setState({ kind: 'denied' });
          return;
        }
        const sorted = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, props.limit);
        setState({ kind: 'ready', rows: sorted });
      } catch {
        if (alive) setState({ kind: 'denied' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.limit]);
  return (
    <WidgetFrame widget="recent_engines">
      {state.kind === 'loading' ? <div style={mutedNote}>Загрузка…</div> : null}
      {state.kind === 'denied' ? <div style={mutedNote}>Нет доступа к данным</div> : null}
      {state.kind === 'ready' && state.rows.length === 0 ? <div style={mutedNote}>Пусто</div> : null}
      {state.kind === 'ready'
        ? state.rows.map((e) => (
            <button key={e.id} type="button" style={rowStyle} onClick={() => props.runtime.openEngine(e.id)}>
              {e.engineBrand || 'Двигатель'} №{e.engineNumber || '—'}
              {e.internalNumberFull ? ` · внутр. ${e.internalNumberFull}` : ''}
              <span style={{ color: theme.colors.muted }}> · {fmtDate(e.updatedAt)}</span>
            </button>
          ))
        : null}
    </WidgetFrame>
  );
}

function MyWorkOrdersWidget(props: { limit: number; runtime: UiIntentRuntime }) {
  const [state, setState] = useState<WidgetState<WorkOrderRow>>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = (await window.matrica.workOrders.list()) as
          | { ok: true; rows: WorkOrderRow[] }
          | { ok: false; error?: string };
        if (!alive) return;
        if (!res || res.ok !== true) {
          setState({ kind: 'denied' });
          return;
        }
        setState({ kind: 'ready', rows: res.rows.slice(0, props.limit) });
      } catch {
        if (alive) setState({ kind: 'denied' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.limit]);
  return (
    <WidgetFrame widget="my_work_orders">
      {state.kind === 'loading' ? <div style={mutedNote}>Загрузка…</div> : null}
      {state.kind === 'denied' ? <div style={mutedNote}>Нет доступа к данным</div> : null}
      {state.kind === 'ready' && state.rows.length === 0 ? <div style={mutedNote}>Пусто</div> : null}
      {state.kind === 'ready'
        ? state.rows.map((w) => (
            <button key={w.id} type="button" style={rowStyle} onClick={() => props.runtime.openWorkOrder(w.id)}>
              Наряд №{w.workOrderNumber} · {w.workType || '—'}
              <span style={{ color: theme.colors.muted }}>
                {' '}
                · {w.engineBrand ? `${w.engineBrand} №${w.engineNumber}` : ''} {fmtDate(w.orderDate)}
              </span>
            </button>
          ))
        : null}
    </WidgetFrame>
  );
}

export function UiListWidget(props: { widget: UiListWidgetId; limit?: number; runtime: UiIntentRuntime }) {
  const limit = props.limit ?? UI_LIST_WIDGET_DEFAULT_LIMIT;
  if (props.widget === 'recent_engines') return <RecentEnginesWidget limit={limit} runtime={props.runtime} />;
  return <MyWorkOrdersWidget limit={limit} runtime={props.runtime} />;
}
