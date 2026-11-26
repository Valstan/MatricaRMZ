import React, { useEffect, useState } from 'react';

import {
  formatSearchProgressCounters,
  formatSearchProgressCurrent,
  formatSearchProgressElapsed,
  isSearchProgressActive,
  searchProgressPercent,
  searchProgressStateLabel,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { cancelSearchProgress, useSearchProgress } from '../services/searchProgressService.js';

/**
 * ПОЛОСА ПРОГРЕССА ПОИСКА — одна на всю программу (промт КАРМАНА #166).
 *
 * Где ищет оператор — там и видно прогресс: обход папок, чтение файлов-источников,
 * поиск по содержимому карточек, серверный глобальный поиск. Рисует их ОДИН
 * этот компонент, с ОДНОЙ подпиской на события (`services/searchProgressService.ts`).
 *
 * ЧТО ВИДИТ ОПЕРАТОР:
 *  * что именно перебирается прямо сейчас («Сейчас смотрим: Э06АТ0889»);
 *  * сколько просмотрено из скольких и сколько найдено;
 *  * сколько прошло времени;
 *  * кнопку «Отмена» — отмена честная: поиск останавливается, отдаётся
 *    частичный результат.
 *
 * ВЁРСТКА. Полоса стоит поверх содержимого (position: fixed) и НЕ двигает
 * список: поля и кнопки под ней остаются на своих местах. Ширина ограничена
 * (`min(420px, 100vw - 32px)`), длинные имена обрезаются, а не переносятся —
 * на планшете полоса остаётся читаемой.
 */
export function SearchProgressBar() {
  const evt = useSearchProgress();
  const [, setTick] = useState(0);

  // Время идёт, а событий может не быть: полоса сама показывает, сколько прошло.
  useEffect(() => {
    if (!evt || !isSearchProgressActive(evt.state)) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, [evt]);

  if (!evt) return null;

  const active = isSearchProgressActive(evt.state);
  const pct = searchProgressPercent(evt);
  const counters = formatSearchProgressCounters(evt);
  const current = formatSearchProgressCurrent(evt);
  const stateLabel = searchProgressStateLabel(evt);
  const elapsed = formatSearchProgressElapsed(Date.now() - evt.startedAt);

  return (
    <div
      data-search-progress-bar=""
      data-search-progress-state={evt.state}
      data-search-progress-kind={evt.kind}
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        width: 'min(420px, calc(100vw - 32px))',
        maxWidth: 'calc(100vw - 32px)',
        zIndex: 7000,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          background: 'var(--surface, #ffffff)',
          border: '1px solid var(--border, rgba(15, 23, 42, 0.15))',
          borderRadius: 12,
          boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
          padding: '10px 12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {evt.title}
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{elapsed}</span>
          {pct != null ? (
            <span style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}>{pct}%</span>
          ) : null}
        </div>

        {current ? (
          <div
            title={current}
            style={{
              marginTop: 4,
              fontSize: 12,
              color: 'var(--text, inherit)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {current}
          </div>
        ) : null}

        {counters ? (
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {counters}
          </div>
        ) : null}

        {evt.detail ? (
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {evt.detail}
          </div>
        ) : null}

        <div
          style={{
            marginTop: 8,
            position: 'relative',
            height: 8,
            borderRadius: 999,
            background: 'rgba(15, 23, 42, 0.12)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              width: `${pct ?? 0}%`,
              background: 'var(--button-primary-bg, #2563eb)',
              transition: 'width 0.4s ease',
            }}
          />
        </div>

        {stateLabel ? (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: evt.state === 'error' ? 'var(--danger, #b91c1c)' : 'var(--muted)',
              fontWeight: 600,
            }}
          >
            {stateLabel}
          </div>
        ) : null}

        {active ? (
          <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="outline"
              size="sm"
              data-search-progress-cancel=""
              onClick={() => void cancelSearchProgress(evt.searchId)}
            >
              Отмена
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
