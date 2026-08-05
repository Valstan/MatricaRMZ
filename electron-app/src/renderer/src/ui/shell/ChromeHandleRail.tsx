import React from 'react';

import { useChromeVisibility } from './ChromeVisibilityContext.js';
import { createEdgeGesture, type GesturePoint } from './edgeGesture.js';

// Рейл выдвижного хрома: узкие хэндлы у краёв, которые видно всегда. Свайп от хэндла
// к центру возвращает слой, тап по хэндлу — то же самое без жеста (страховка: часть
// прошивок Android забирает краевой свайп себе под «назад»).
//
// Хэндлы стоят с ОТСТУПОМ от физического края (--mx-rail-inset): полосу 0..20dp у
// боковых краёв держит системный жест, отобрать её из JS нельзя.

const DRAWER_SELECTOR = '.mx-drawer--left';
/** Ход верхнего слоя для распознавания свайпа (высота шапки + полосы вкладок, грубо). */
const TOP_LAYER_TRAVEL_PX = 120;

function point(e: React.PointerEvent | PointerEvent): GesturePoint {
  return { x: e.clientX, y: e.clientY, t: e.timeStamp };
}

/**
 * Один хэндл: распознаёт свайп своей оси и отдаёт решение «открыть/закрыть».
 * Мышь игнорируется — на десктопе рейла нет вовсе, а на планшете с подключённой мышью
 * жест бессмысленен (для неё есть тап).
 */
function Handle(props: {
  className: string;
  title: string;
  label: string;
  axis: 'x' | 'y';
  direction: 1 | -1;
  travel: number;
  open: boolean;
  /** Элемент, который следует за пальцем (выдвижная панель). Нет — жест только распознаётся. */
  followSelector?: string;
  onCommit: (open: boolean) => void;
  onTap: () => void;
}) {
  const gestureRef = React.useRef<ReturnType<typeof createEdgeGesture> | null>(null);
  const followRef = React.useRef<HTMLElement | null>(null);
  const movedRef = React.useRef(false);

  const paint = React.useCallback((progress: number | null) => {
    const el = followRef.current;
    if (!el) return;
    if (progress == null) {
      delete el.dataset.mxDragging;
      el.style.removeProperty('--mx-drawer-progress');
      return;
    }
    el.dataset.mxDragging = '1';
    // Пишем ТОЛЬКО в style самой панели: запись в :root.style будит глобальный
    // MutationObserver автоподгонки полей (useAutoGrowInputs) на каждом кадре драга.
    el.style.setProperty('--mx-drawer-progress', String(progress));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    movedRef.current = false;
    followRef.current = props.followSelector
      ? document.querySelector<HTMLElement>(props.followSelector)
      : null;
    gestureRef.current = createEdgeGesture({
      axis: props.axis,
      size: props.travel,
      direction: props.direction,
      open: props.open,
    });
    gestureRef.current.start(point(e));
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const s = g.move(point(e));
    if (s.phase !== 'captured') return;
    movedRef.current = true;
    // preventDefault только ПОСЛЕ захвата: до него палец должен уметь прокручивать.
    e.preventDefault();
    paint(s.progress);
  };

  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    const r = cancelled ? g.cancel() : g.end(point(e));
    paint(null);
    followRef.current = null;
    if (cancelled || movedRef.current) {
      if (r.open !== props.open) props.onCommit(r.open);
      return;
    }
    props.onTap();
  };

  return (
    <button
      type="button"
      className={`mx-rail-handle ${props.className}`}
      data-mx-open={props.open ? '1' : '0'}
      title={props.title}
      aria-label={props.title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => finish(e, false)}
      onPointerCancel={(e) => finish(e, true)}
      onClick={(e) => {
        // Мышь/клавиатура: жеста не было — обычное переключение.
        if (e.detail === 0 || !movedRef.current) props.onTap();
      }}
    >
      {props.label}
    </button>
  );
}

export function ChromeHandleRail() {
  const chrome = useChromeVisibility();
  if (!chrome.enabled) return null;

  const topHidden = chrome.state.hidden.tabStrip || chrome.state.hidden.appHeader;
  const sectionsOpen = !chrome.state.hidden.sections;

  return (
    <div className="mx-chrome-rail" aria-hidden={false}>
      <Handle
        className="mx-rail-top"
        title={topHidden ? 'Показать панели (свайп вниз)' : 'Убрать панели ради данных'}
        label={topHidden ? '▾' : '▴'}
        axis="y"
        direction={1}
        travel={TOP_LAYER_TRAVEL_PX}
        open={!topHidden}
        onCommit={(open) => (open ? chrome.show() : chrome.hide())}
        onTap={() => (topHidden ? chrome.show() : chrome.hide())}
      />
      <Handle
        className="mx-rail-left"
        title={sectionsOpen ? 'Скрыть разделы' : 'Разделы (свайп вправо)'}
        label="☰"
        axis="x"
        direction={1}
        travel={320}
        open={sectionsOpen}
        followSelector={DRAWER_SELECTOR}
        onCommit={(open) => (open ? chrome.show('sections') : chrome.hide('sections'))}
        onTap={() => chrome.toggle('sections')}
      />
      <Handle
        className="mx-rail-search"
        title="Поиск и кнопки списка"
        label="🔍"
        axis="y"
        direction={1}
        travel={TOP_LAYER_TRAVEL_PX}
        open={!chrome.state.hidden.pageToolbar}
        onCommit={(open) => (open ? chrome.show('pageToolbar') : chrome.hide('pageToolbar'))}
        onTap={() => {
          chrome.show('pageToolbar');
          // Поиск — самое частое действие в цеху: возвращаем панель и сразу ставим курсор.
          // setTimeout, а не rAF: кадры могут не идти (окно свёрнуто/экран погашен), а
          // курсор обязан встать — иначе тап по язычку выглядит как «не сработало».
          setTimeout(() => {
            document
              .querySelector<HTMLInputElement>('.mx-page-toolbar input:not([type=checkbox]):not([disabled])')
              ?.focus();
          }, 0);
        }}
      />
      {sectionsOpen && (
        <div
          className="mx-scrim"
          role="presentation"
          onPointerDown={() => chrome.hide('sections')}
        />
      )}
    </div>
  );
}
