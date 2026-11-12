import React from 'react';

import { emojiAttrs } from '../utils/labelEmoji.js';
import { isAndroidPlatform } from '../platform.js';

/**
 * Описание колонки списка — то же, что описывало панель «Колонки списка».
 */
export type ColumnDescriptor = {
  id: string;
  label: string;
  tabletLabel?: string;
  alwaysVisible?: boolean;
};

/**
 * Ряд плашек видимости колонок (владелец 12.11.2026).
 *
 * «Между панелью фильтров и строкой шапки списка разместить кнопки-плашки, такого же
 * размера, как плашки фильтров, только нецветные… Белая кнопка — значит, колонка не включена
 * в списки, а если она выделена, пусть будет тёмно-серым, — то есть при нажатии на плашку
 * данная колонка в списке должна быть включена, отображаться в списке и идти на печать».
 *
 * То есть это **строка управления видимостью колонок**, а кнопка «Колонки списка» из панели
 * управляющих кнопок убрана совсем: настраивать колонки теперь этим рядом.
 *
 * Почему «идти на печать»: печать и выгрузка берут по умолчанию ровно те колонки, что видны
 * на экране (`resolvePrintColumnIds` — `visibleColumnIds`), поэтому включённая плашка
 * означает и колонку в листе.
 *
 * Свойства ряда (владелец 12.11.2026):
 *
 * - **одна строка на всю ширину программы** — плашки не переносятся и не наезжают друг на
 *   друга; если ряд всё же шире окна, он прокручивается по горизонтали, а не обрезается;
 * - **подписи мельче**, чем у обычных надписей, — иначе в строку влезает полтора десятка
 *   колонок, а не все;
 * - **перетаскиванием** плашки меняются местами: порядок колонок настраивается здесь же,
 *   раз панель «Колонки списка» из тулбара убрана.
 */

/** Включённая колонка — тёмно-серый (владелец 12.11.2026: «пусть будет темно серым»). */
const CHIP_ON_BACKGROUND = 'hsl(215 19% 32%)';
/** Выключенная колонка — белая (владелец 12.11.2026: «белая кнопка — колонка не включена»). */
const CHIP_OFF_BACKGROUND = '#ffffff';

function chipStyle(on: boolean, locked: boolean): React.CSSProperties {
  return {
    padding: '1px 4px',
    borderRadius: 3,
    border: locked ? '1px solid var(--border)' : '1px solid transparent',
    background: on ? CHIP_ON_BACKGROUND : CHIP_OFF_BACKGROUND,
    color: on ? '#ffffff' : 'var(--text)',
    cursor: locked ? 'default' : 'pointer',
    whiteSpace: 'nowrap',
    fontSize: 11,
    lineHeight: 1.25,
    maxWidth: 140,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flex: '0 0 auto',
  };
}

export function ListColumnChips(props: {
  /** Все колонки списка — по ним строится ряд плашек. */
  columns: ColumnDescriptor[];
  /** Порядок колонок в раскладке (с учётом перетаскивания). */
  order: string[];
  isVisible: (id: string) => boolean;
  onToggleVisible: (id: string, visible: boolean) => void;
  /** Поставить колонку перед указанной (перетаскивание плашки). */
  onMoveTo?: (id: string, targetId: string) => void;
  /** Вернуть набор и порядок колонок по умолчанию. */
  onReset?: () => void;
}) {
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [dropId, setDropId] = React.useState<string | null>(null);

  const byId = React.useMemo(() => new Map(props.columns.map((column) => [column.id, column])), [props.columns]);
  const ordered = React.useMemo(
    () => props.order.map((id) => byId.get(id)).filter((column): column is ColumnDescriptor => Boolean(column)),
    [props.order, byId],
  );
  // Колонки, о которых страница не знает (например, список переехал), в ряд не попадают.
  const extra = React.useMemo(
    () => props.columns.filter((column) => !props.order.includes(column.id)),
    [props.columns, props.order],
  );
  const chips = [...ordered, ...extra];

  function handleDrop(targetId: string) {
    const dragged = dragId;
    setDragId(null);
    setDropId(null);
    if (!dragged || dragged === targetId) return;
    props.onMoveTo?.(dragged, targetId);
  }

  return (
    <div
      data-list-column-chips
      className="list-column-chips"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        flexWrap: 'nowrap',
        overflowX: 'auto',
        overflowY: 'hidden',
        padding: '2px 0',
        // Ряд стоит рядом со строкой статистики («Всего: N · Показано: M»), поэтому он должен
        // ужиматься, а не распирать строку: без `minWidth: 0` флекс-элемент не сжимается
        // меньше своего содержимого и уезжает за правый край окна.
        flex: '1 1 auto',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          whiteSpace: 'nowrap',
          flex: '0 0 auto',
          paddingRight: 2,
        }}
      >
        Колонки:
      </span>
      {chips.map((column) => {
        const on = props.isVisible(column.id);
        const locked = column.alwaysVisible === true;
        const label = isAndroidPlatform() ? (column.tabletLabel ?? column.label) : column.label;
        const isDropTarget = dropId === column.id && dragId !== column.id;
        return (
          <button
            key={column.id}
            type="button"
            data-list-column-chip={column.id}
            data-list-column-chip-state={on ? 'on' : 'off'}
            draggable={!locked && Boolean(props.onMoveTo)}
            onDragStart={(event) => {
              setDragId(column.id);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', column.id);
            }}
            onDragOver={(event) => {
              if (!dragId || dragId === column.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropId(column.id);
            }}
            onDragLeave={() => {
              if (dropId === column.id) setDropId(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop(column.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropId(null);
            }}
            onClick={() => {
              if (locked) return;
              props.onToggleVisible(column.id, !on);
            }}
            title={
              locked
                ? `${label} — эта колонка всегда в списке`
                : on
                  ? `${label} — нажмите, чтобы убрать колонку из списка и печати`
                  : `${label} — нажмите, чтобы вернуть колонку в список и печать`
            }
            aria-pressed={on}
            style={{
              ...chipStyle(on, locked),
              ...(isDropTarget ? { outline: '1px dashed var(--muted)', outlineOffset: 1 } : {}),
              ...(dragId === column.id ? { opacity: 0.5 } : {}),
            }}
          >
            <span {...emojiAttrs(label)}>{label}</span>
          </button>
        );
      })}
      {props.onReset ? (
        <button
          type="button"
          data-list-column-chips-reset
          onClick={props.onReset}
          title="Вернуть набор и порядок колонок по умолчанию"
          aria-label="Сбросить колонки"
          style={{
            flex: '0 0 auto',
            border: 'none',
            background: 'transparent',
            color: 'var(--muted)',
            cursor: 'pointer',
            fontSize: 11,
            lineHeight: 1.25,
            padding: '1px 2px',
          }}
        >
          ↺
        </button>
      ) : null}
    </div>
  );
}
