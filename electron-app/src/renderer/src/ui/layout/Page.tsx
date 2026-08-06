import React from 'react';

import { theme } from '../theme.js';
import rmzLogo from '../../assets/logo_rmz.png';

const RMZ_LOGO_SRC = rmzLogo;

/**
 * Верхняя панель: логотип, название и все кнопки — одной центрированной строкой.
 * Переполнение НЕ уезжает на второй ряд (шапка съедала рабочее место): вместо
 * переноса гаснут подписи кнопок, начиная с наименее важных. Приоритет задаётся
 * атрибутом `data-hdr-label` на span'е подписи — чем больше число, тем раньше
 * подпись прячется. Иконка остаётся всегда, поэтому кнопка не исчезает.
 */
function HeaderBar(props: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement | null>(null);

  const fit = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflows = () => el.scrollWidth > el.clientWidth + 1;
    const title = el.querySelector<HTMLElement>('[data-hdr-title]');
    const shrinkables = Array.from(el.querySelectorAll<HTMLElement>('[data-hdr-compact]'));
    const labels = Array.from(el.querySelectorAll<HTMLElement>('[data-hdr-label]')).sort(
      (a, b) => Number(b.dataset.hdrLabel ?? 0) - Number(a.dataset.hdrLabel ?? 0),
    );

    // Сброс перед замерами обязателен, и `justifyContent` — в первую очередь: при
    // `flex-end` переполнение уходит ВЛЕВО и в `scrollWidth` не попадает, то есть
    // проверка переполнения молча вернула бы «всё влезло» и ступени не сработали бы.
    el.style.justifyContent = '';
    for (const label of labels) label.style.display = '';
    for (const item of shrinkables) item.style.maxWidth = '';
    if (title) {
      title.style.flex = '0 0 auto';
      title.style.minWidth = '';
    }

    // Ступень 1 — гаснут подписи кнопок, начиная с наименее важных. Иконка остаётся.
    for (const label of labels) {
      if (!overflows()) break;
      label.style.display = 'none';
    }
    // Ступень 2 — поля без подписи (выбор гаммы) сжимаются до иконки.
    for (const item of shrinkables) {
      if (!overflows()) break;
      item.style.maxWidth = `${Number(item.dataset.hdrCompact ?? 44)}px`;
    }
    // Ступень 3 — последним ужимается название (…): строка отцентрована, и при
    // переполнении её резало бы с ОБОИХ краёв, унося и кнопку входа.
    if (title && overflows()) {
      title.style.flex = '0 1 auto';
      title.style.minWidth = '0';
    }
    // Если и этого мало (окно сузили до неприличия) — прижимаем вправо: обрезать
    // логотип не жалко, а кнопка входа и синхронизация должны остаться кликабельны.
    el.style.justifyContent = overflows() ? 'flex-end' : '';
  }, []);

  // Набор кнопок меняется от прав, режима и оболочки — примеряем на каждый рендер.
  React.useLayoutEffect(() => {
    fit();
  });

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  return (
    <div ref={ref} className="hdr-bar">
      {props.children}
    </div>
  );
}

export function Page(props: {
  title: string;
  right?: React.ReactNode;
  topBanner?: React.ReactNode;
  children: React.ReactNode;
  uiTheme?: 'light' | 'dark' | 'warm';
}) {
  const gradient =
    props.uiTheme === 'light'
      ? `linear-gradient(135deg, #e2e8f0 0%, #f8fafc 45%, #e0f2fe 100%)`
      : props.uiTheme === 'warm'
        ? `linear-gradient(135deg, #efe1c6 0%, #faf1dd 45%, #f3e3c3 100%)`
        : `linear-gradient(135deg, ${theme.colors.appBgFrom} 0%, ${theme.colors.appBgVia} 45%, ${theme.colors.appBgTo} 100%)`;
  return (
    <div
      style={{
        height: '100vh',
        background: gradient,
        padding: 0,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontFamily: 'system-ui',
          width: '100%',
          height: '100%',
          border: 'none',
          background: theme.colors.surface,
          boxShadow: 'none',
          padding: 0,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* mx-chrome-slot--header — якорь планшетного режима «данные на весь экран»:
            на Android шапка уезжает целиком (display:none), на десктопе класс без правил. */}
        <div
          className="mx-chrome-slot mx-chrome-slot--header"
          style={{
            display: 'flex',
            alignItems: 'center',
            flex: '0 0 auto',
            padding: '6px 8px',
            background: '#0b2d63',
            color: '#ffffff',
            borderBottom: '1px solid rgba(255,255,255,0.14)',
            minHeight: 34,
          }}
        >
          <HeaderBar>
            <img
              src={RMZ_LOGO_SRC}
              alt="RMZ"
              style={{ height: 18, width: 'auto', objectFit: 'contain' }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            <h1
              data-hdr-title=""
              style={{
                margin: 0,
                fontSize: 15,
                fontWeight: 800,
                color: '#ffffff',
                lineHeight: 1.15,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: '38vw',
              }}
              title={props.title}
            >
              {props.title}
            </h1>
            {props.right}
          </HeaderBar>
        </div>
        {props.topBanner ? <div style={{ marginTop: 8 }}>{props.topBanner}</div> : null}
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}>{props.children}</div>
      </div>
    </div>
  );
}



