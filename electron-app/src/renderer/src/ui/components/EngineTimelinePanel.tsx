import React, { useEffect, useState } from 'react';

import { buildEngineTimeline, ENGINE_LIFECYCLE_PHASE_ORDER, type EngineTimelineItem } from '@matricarmz/shared';

import { SectionCard } from './SectionCard.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';

/**
 * Паспорт ремонта — read-only лента событий по двигателю (brain-бэклог #1).
 * Тянет уже существующий `operations.list(engineId)`, нормализует через shared
 * `buildEngineTimeline` и рисует хронологические карточки (новые сверху). Без
 * записи/схемы — визуальный паспорт одного заезда. Гейт — `operations.view`
 * (вкладка показывается только при `canView`).
 */
export function EngineTimelinePanel(props: { engineId: string; resolveFullName?: (login: string) => string }) {
  const [items, setItems] = useState<EngineTimelineItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    void (async () => {
      try {
        const rows = await window.matrica.operations.list(props.engineId);
        if (!alive) return;
        setItems(buildEngineTimeline(rows));
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.engineId]);

  return (
    <SectionCard
      title="История ремонта (паспорт)"
      style={{ padding: 16, background: 'rgba(16, 185, 129, 0.06)' }}
    >
      {error ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>Не удалось загрузить: {error}</div> : null}
      {!error && items === null ? <div style={{ color: 'var(--subtle)', fontSize: 13 }}>Загрузка…</div> : null}
      {!error && items !== null && items.length === 0 ? (
        <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
          По этому двигателю ещё нет зафиксированных событий (приёмка, дефектовка, акты, передачи).
        </div>
      ) : null}
      {items !== null && items.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {items.map((it, idx) => (
            <TimelineRow
              key={it.id}
              item={it}
              last={idx === items.length - 1}
              who={resolveWho(it.performedBy, props.resolveFullName)}
            />
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}

function resolveWho(login: string | null, resolve?: (login: string) => string): string {
  const raw = String(login ?? '').trim();
  if (!raw || raw === 'local') return '';
  const full = resolve ? resolve(raw) : '';
  return full && full !== raw ? `${full} (${raw})` : raw;
}

function phaseColor(phase: EngineTimelineItem['phase']): string {
  const order = ENGINE_LIFECYCLE_PHASE_ORDER[phase];
  if (order <= 10) return '#3b82f6';
  if (order <= 20) return '#f59e0b';
  if (order <= 40) return '#8b5cf6';
  if (order <= 70) return '#10b981';
  if (order >= 90) return '#059669';
  return '#6b7280';
}

function TimelineRow(props: { item: EngineTimelineItem; last: boolean; who: string }) {
  const { item, last, who } = props;
  const color = phaseColor(item.phase);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
      {/* Рельс с точкой и линией */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 24 }}>
        <div
          style={{
            width: 24,
            height: 24,
            borderRadius: '50%',
            background: color,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            flexShrink: 0,
          }}
          aria-hidden
        >
          {item.icon}
        </div>
        {!last ? <div style={{ flex: 1, width: 2, background: 'var(--border)', minHeight: 12 }} /> : null}
      </div>
      {/* Контент */}
      <div style={{ paddingBottom: last ? 0 : 14, minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ fontWeight: 700, fontSize: 13 }}>{item.label}</span>
          {item.statusLabel ? (
            <span
              style={{
                fontSize: 11,
                padding: '1px 7px',
                borderRadius: 10,
                background: 'var(--surface-2, rgba(0,0,0,0.06))',
                color: 'var(--subtle)',
              }}
            >
              {item.statusLabel}
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: 'var(--subtle)', marginLeft: 'auto' }}>{formatMoscowDateTime(item.at)}</span>
        </div>
        {item.note ? <div style={{ fontSize: 12, marginTop: 2, whiteSpace: 'pre-wrap' }}>{item.note}</div> : null}
        {who ? <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 2 }}>Ответственный: {who}</div> : null}
      </div>
    </div>
  );
}
