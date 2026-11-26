import React, { useEffect, useRef, useState } from 'react';
import {
  clearFacet,
  facetOptions,
  toggleFacetValue,
  type FacetDescriptor,
  type FacetSelection,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { PopupLayer, useAnchoredPopup } from './PopupLayer.js';

/**
 * Быстрый доступ к отбору по виду («ГОЗ / гражданка») — кнопка в тулбаре списка.
 *
 * Промт КАРМАНА #163: «Сейчас ступень „Вид“ спрятана внутри свёрнутой панели „Фильтры“… Оператор
 * открывает список — фильтра по виду он не видит». Панель по решению владельца от 25.11.2026
 * сворачивается за кнопку, и отбор по виду до неё ещё надо дотянуться. Кнопка в тулбаре — вторая
 * точка входа в **тот же самый** отбор: состояние у неё и у панели ступеней одно, поэтому
 * выбор из кнопки виден в панели, а снятие значения в панели — и в кнопке.
 *
 * **Числа рядом со значениями — те же, что в панели ступеней** (считает тот же движок
 * `facetOptions` по тем же строкам): оператор видит, сколько строк каждого вида, и понимает,
 * почему список после отбора стал короче — в том числе почему в «ГОЗ» не попало ни строки с
 * видом «не задан».
 *
 * Подписи короткие («ГОЗ» / «Гражд.»): кнопка живёт в тулбаре, где места мало, особенно на
 * планшете. Полная подпись («Гражданский») остаётся в карточках и печатных формах.
 */
export function KindQuickFilter<Row>(props: {
  /** Ступени списка — по ним считаются числа (те же ступени, что у панели фильтров). */
  facets: readonly FacetDescriptor<Row>[];
  /** Строки списка — по ним считаются числа. */
  rows: readonly Row[];
  /** Отбор списка — то же состояние, что у панели фильтров. */
  selection: FacetSelection;
  onChangeSelection: (next: FacetSelection) => void;
  /** Id ступени вида — по умолчанию `kind`. */
  facetId?: string;
}) {
  const facetId = props.facetId ?? 'kind';
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const popup = useAnchoredPopup(open, anchor, { compactWidth: true });

  const options = React.useMemo(
    () => facetOptions(props.facets, props.rows, props.selection, facetId),
    [props.facets, props.rows, props.selection, facetId],
  );

  const picked = Array.isArray(props.selection[facetId]) ? (props.selection[facetId] as string[]) : [];
  const pickedLabels = options.filter((o) => picked.includes(o.value)).map((o) => o.label);
  const buttonText = pickedLabels.length === 0 ? 'ГОЗ / Гражд.' : `Вид: ${pickedLabels.join(', ')}`;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (popup.node?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, popup.node]);

  function toggle(value: string) {
    props.onChangeSelection(toggleFacetValue(props.selection, facetId, value));
  }

  function clearAll() {
    props.onChangeSelection(clearFacet(props.selection, facetId));
  }

  return (
    <div
      ref={(el) => {
        (rootRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        setAnchor(el);
      }}
      style={{ position: 'relative', display: 'inline-flex' }}
      data-kind-quick-filter
    >
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Отбор по виду: ГОЗ или гражданка"
        data-kind-quick-toggle
        style={pickedLabels.length > 0 ? { borderColor: 'var(--info)', color: 'var(--info)' } : undefined}
      >
        {buttonText}
      </Button>
      {open ? (
        <PopupLayer>
          <div
            ref={popup.ref}
            style={{
              ...popup.style,
              padding: 8,
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--panel)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              minWidth: 200,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Вид</span>
              <Button type="button" variant="ghost" size="sm" onClick={clearAll} data-kind-quick-clear>
                Все
              </Button>
            </div>
            {options.map((option) => (
              <label
                key={option.value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  userSelect: 'none',
                  fontSize: 13,
                }}
                data-kind-quick-option={option.value}
              >
                <input type="checkbox" checked={option.selected} onChange={() => toggle(option.value)} />
                <span style={{ flex: '1 1 auto' }}>{option.label}</span>
                <span style={{ opacity: 0.6 }}>{option.count}</span>
              </label>
            ))}
          </div>
        </PopupLayer>
      ) : null}
    </div>
  );
}
