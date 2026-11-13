import React from 'react';

/**
 * ЕДИНЫЙ ДВИЖОК ТАБЛИЦ ВНУТРИ КАРТОЧЕК.
 *
 * Шапка таблицы (`table thead` в `global.css`) липнет к своему скролл-контексту и
 * отступает вниз на высоту закреплённой «шапки карточки» (панель действий + полоса
 * вкладок) — иначе она заезжала бы под вкладки. Смещение это верно ТОЛЬКО тогда,
 * когда скролл-контекст шапки — тот же прокручиваемый бокс карточки.
 *
 * Если таблицу замкнуть в собственный скролл-контейнер (`overflow: auto|hidden`),
 * контекстом становится он: шапка липнет внутри обёртки, смещение «шапки карточки»
 * сдвигает её вниз — и она НАКРЫВАЕТ первую строку (владелец 13.11.2026: «шапка
 * наезжает на верхнюю строку, её не видно»).
 *
 * Поэтому здесь обёртка БЕЗ прокрутки: шапка липнет к прокрутке карточки, как надо,
 * а широкую таблицу прокрутит прокручиваемый бокс карточки (overflow:auto по обеим
 * осям) — ровно как список двигателей.
 *
 * Режимы:
 *  - `default` — без прокрутки (основной): шапка липнет к прокрутке карточки;
 *  - `clip`    — `overflow: clip`: скруглённые углы, прокрутки не создаётся;
 *  - `scroll`  — своя горизонтальная прокрутка (широкая фиксированная раскладка).
 *                Тогда смещение «шапки карточки» здесь не действует, и шапка липнет
 *                к своему боксу (правило `top: 0` в `global.css`).
 */
export type CardTableMode = 'default' | 'clip' | 'scroll';

export function CardTable(props: {
  children: React.ReactNode;
  /** Класс таблицы (например `list-table`). */
  className?: string;
  /** Стиль таблицы. */
  style?: React.CSSProperties;
  /** Класс обёртки (в дополнение к классу режима). */
  wrapClassName?: string;
  /** Стиль обёртки (рамка, скругление и т.п.). */
  wrapStyle?: React.CSSProperties;
  /** Режим обёртки. */
  mode?: CardTableMode;
}) {
  const mode = props.mode ?? 'default';
  const wrapClass = [
    'card-table-wrap',
    mode === 'clip' ? 'card-table-wrap--clip' : null,
    mode === 'scroll' ? 'card-table-wrap--scroll card-table-scroll-context' : null,
    props.wrapClassName ?? null,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={wrapClass} style={props.wrapStyle}>
      <table className={`ui-table${props.className ? ` ${props.className}` : ''}`} style={props.style}>
        {props.children}
      </table>
    </div>
  );
}
