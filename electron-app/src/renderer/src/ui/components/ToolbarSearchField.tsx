import React, { useCallback, useRef, useState } from 'react';

import type { SearchFieldOption } from '@matricarmz/shared';

import { Input } from './Input.js';
import { SearchFieldPicker } from './SearchFieldPicker.js';
import { type SearchFieldChoice } from '../hooks/useSearchField.js';

/**
 * Поле поиска в панели кнопок списка (владелец 13.11.2026, промты КАРМАНА #9 и #13;
 * владелец 24.11.2026, промт #118 — ряд кнопок влево и мельче на планшете).
 *
 * Правило одно и общее для всех списков: **поле раздвигается при фокусе и сжимается обратно
 * без фокуса**. Пока оператор не начал печатать, поле занимает в ряду скромное место; при фокусе
 * оно накладывается поверх соседних кнопок — так в поле влезает длинный запрос, а ряд кнопок
 * не пересчитывается (пересчёт по спрятанным элементам отдал бы нулевые ширины и схлопнул ряд
 * в одну кнопку — см. комментарий в `PageToolbar.tsx`).
 *
 * Накладка, а не перестройка ряда: поле уходит из потока (уходит и его место в ряду — обёртка
 * держит базовую ширину), а правый край ряда подрезает её по месту.
 *
 * Ширина свёрнутого поля — АДАПТИВНАЯ (класс `.mx-toolbar-search` в global.css: доля от
 * ширины ряда с потолком и полом). Константы в пикселях больше нет: на планшете 1024 px
 * фиксированные 280 px — это почти треть экрана, и ряд кнопок не помещался (жалоба владельца
 * 24.11.2026). Ширина от размера окна зависит — значит, кэш ширин ряда пересчитывается
 * вместе с ней (в `PageToolbar` ширина окна входит в подпись замера).
 *
 * Текст при сжимании обрезается по ширине поля, а не исчезает: значение поля не меняется.
 *
 * Рядом с полем — кнопка «где искать» (промт КАРМАНА #138, 25.11.2026): поиск сам знает,
 * в какой сущности он стоит, и по кнопке можно сузить выдачу до одного поля. Кнопка —
 * часть общей панели (не отдельное поле рядом) и остаётся доступной под раздвинутым полем.
 */

/** Потолок развёрнутого поля: больше — уже не поиск, а полоса во всю окна. */
const MAX_WIDTH = 480;
/** Резерв под кнопку «⋯» у края ряда: развёрнутое поле её не закрывает. */
const MENU_RESERVE = 54;
/** Зазор между полем и кнопкой «где искать» — как между кнопками ряда. */
const FIELD_GAP = 6;
/** Высота поля — держим и когда поле ушло в накладку (в потоке его тогда нет). */
const FIELD_HEIGHT = 'var(--ui-input-height, 28px)';

export function ToolbarSearchField(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  /** Поля текущей сущности — из них кнопка «где искать» и предлагает выбор. */
  fieldOptions?: SearchFieldOption[];
  /** Выбранное поле; `null` — «искать везде». */
  fieldChoice?: SearchFieldChoice | null;
  onSelectField?: (choice: SearchFieldChoice | null) => void;
}) {
  const [expandedWidth, setExpandedWidth] = useState<number | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);

  const expand = useCallback(() => {
    const wrap = wrapRef.current;
    const row = wrap?.closest('[data-page-toolbar]');
    if (!wrap || !row) return;
    const rowRect = row.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    // Слева — край ряда, справа — кнопка «⋯»: поле может закрыть всё между ними.
    const left = wrapRect.left - rowRect.left - row.clientLeft;
    // Кнопка «где искать» стоит рядом с полем — развёрнутое поле её не закрывает.
    const pickerButton = wrap.parentElement?.querySelector<HTMLElement>('[data-search-field="button"]');
    const pickerReserve = pickerButton ? (pickerButton.parentElement?.offsetWidth ?? 0) + FIELD_GAP : 0;
    const room = row.clientWidth - left - MENU_RESERVE - pickerReserve;
    // Свёрнутое поле уже адаптивно (мельче на узком экране) — развёрнутое не уже его.
    const collapsed = Math.round(wrapRect.width);
    setExpandedWidth(Math.max(collapsed, Math.min(MAX_WIDTH, Math.round(room))));
  }, []);

  return (
    <>
      <span
        ref={wrapRef}
        data-toolbar-search
        data-toolbar-search-expanded={expandedWidth != null ? 'on' : 'off'}
        className="mx-toolbar-search"
        style={{
          // Обёртка — containing block накладки: развёрнутое поле растёт вправо от своего места.
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          minWidth: 0,
          height: FIELD_HEIGHT,
        }}
      >
        <Input
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          placeholder={props.placeholder}
          aria-label={props.ariaLabel}
          onKeyDown={(e) => {
            // Escape убирает курсор из поиска и возвращает ряд — как в любом поле с отменой.
            if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            props.onKeyDown?.(e);
          }}
          onFocus={expand}
          onBlur={() => setExpandedWidth(null)}
          style={
            expandedWidth != null
              ? { position: 'absolute', left: 0, top: 0, width: expandedWidth, height: FIELD_HEIGHT, zIndex: 5 }
              : { width: '100%' }
          }
        />
      </span>
      {props.fieldOptions && props.fieldOptions.length > 0 ? (
        // Кнопка «где искать» — в той же панели, что и поле, и под раздвинутым полем
        // остаётся доступной (z-index выше накладки).
        <span style={{ marginLeft: FIELD_GAP, display: 'inline-flex', flex: '0 0 auto' }}>
          <SearchFieldPicker
            options={props.fieldOptions}
            choice={props.fieldChoice ?? null}
            onSelect={props.onSelectField ?? (() => {})}
          />
        </span>
      ) : null}
    </>
  );
}
