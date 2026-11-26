import React, { useEffect, useMemo, useRef, useState } from 'react';

import { globalSearchKindLabel, searchFieldOptionsFor, type SearchFieldOption } from '@matricarmz/shared';

import { PopupLayer, useAnchoredPopup } from './PopupLayer.js';
import { type SearchFieldChoice } from '../hooks/useSearchField.js';

/**
 * Кнопка «где искать» рядом с полем поиска (владелец 25.11.2026, промт КАРМАНА #138).
 *
 * Смысл: поиск сам знает, в какой сущности он находится, и показывает доступные там
 * поля («номер двигателя», «внутренний номер», «номер контракта»…). Выбранное поле
 * сужает выдачу: остаются только совпадения ПО НЕМУ, остальные вхождения не
 * показываются вовсе (владелец: «тогда будут выдаваться только совпадение по номерам
 * двигателей, остальные вхождения он показывать не будет»).
 *
 * Правила кнопки:
 * - по умолчанию — «Искать везде» (то есть поле не выбрано, выдача обычная);
 * - выбор поля ВИДЕН на кнопке: без этого «пропавшие» совпадения читаются как поломка;
 * - сброс в «Искать везде» — одним кликом (первый пункт списка), а не перезапуском поиска;
 * - кнопка НЕ трогает режим поиска («точный» / «≈ Похожие») — это независимый переключатель.
 *
 * Метка в DOM (`data-search-field`) — обязательна: смоук ищет кнопку по метке, а не по
 * типу компонента (тип ломается на горячей перезагрузке, M120).
 */

/** Подпись кнопки, когда поле не выбрано. */
export const SEARCH_FIELD_EVERYWHERE = 'Искать везде';

/**
 * Что говорить, когда выдача сужена: часть слоёв (серверный поиск, поиск внутри
 * карточек) поля не знает — при выбранном поле они молча выключены. Молчать об этом
 * нельзя: оператор увидит «пропавшие» совпадения и решит, что поиск сломан.
 */
export const SEARCH_FIELD_NARROWED_NOTE =
  'Ищем только по выбранному полю. Серверный поиск и поиск внутри карточек выключены: они не умеют искать по полю.';

export function SearchFieldPicker(props: {
  /** Поля, которые доступны в текущей сущности (или в сущностях палитры). */
  options: SearchFieldOption[];
  /** Выбранное поле; `null` — «искать везде». */
  choice: SearchFieldChoice | null;
  onSelect: (choice: SearchFieldChoice | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const popup = useAnchoredPopup(open, anchor, { align: 'left' });
  const menuRef = useRef<HTMLDivElement | null>(null);

  const options = useMemo(() => props.options ?? [], [props.options]);
  // Выбранное поле показываем ВСЕГДА — даже если его больше нет в списке (например,
  // в строках оно нигде не заполнено). Иначе кнопка сказала бы «искать везде», а
  // выдача осталась бы суженой: оператор решил бы, что это поломка.
  const chosen = useMemo(() => {
    if (!props.choice) return undefined;
    const inOptions = options.find((o) => o.id === props.choice?.fieldId && o.kind === props.choice?.kind);
    if (inOptions) return inOptions;
    return searchFieldOptionsFor(props.choice.kind).find((o) => o.id === props.choice?.fieldId);
  }, [options, props.choice]);

  // Клик мимо — закрыть. Меню живёт в портале, поэтому слушаем документ, а не предка.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(ev: PointerEvent) {
      const target = ev.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      if (target && popup.node?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, popup.node]);

  // Подсказка объясняет правило: выбор держится, пока вы на этом списке.
  const title = chosen
    ? `Ищем только по полю «${chosen.title}». Нажмите, чтобы вернуть «${SEARCH_FIELD_EVERYWHERE}»`
    : 'Искать везде. Нажмите, чтобы сузить поиск по одному полю (номер двигателя, договор и т. п.)';

  // Группировка по сущности: в палитре полей много, и без заголовков они неразличимы.
  const groups: Array<{ kind: string; title: string; items: SearchFieldOption[] }> = [];
  for (const option of options) {
    const last = groups[groups.length - 1];
    if (last && last.kind === option.kind) last.items.push(option);
    else groups.push({ kind: option.kind, title: globalSearchKindLabel(option.kind), items: [option] });
  }
  const singleGroup = groups.length <= 1;

  return (
    <>
      <span
        ref={setAnchor}
        style={{ position: 'relative', zIndex: 6, display: 'inline-flex', flex: '0 0 auto' }}
      >
        <button
          type="button"
          data-search-field="button"
          data-search-field-state={chosen ? 'field' : 'all'}
          onClick={() => setOpen((v) => !v)}
          title={title}
          style={{
            padding: '6px 10px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: chosen ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
            fontWeight: chosen ? 700 : 400,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            // Поле поиска при фокусе накладывается поверх соседних кнопок — эту кнопку
            // накладка закрывать не должна: выбрать поле, не убирая курсор из поиска,
            // — обычное дело (как кнопка «≈ Похожие»).
            position: 'relative',
            zIndex: 6,
          }}
        >
          {chosen ? `По ${chosen.title}` : SEARCH_FIELD_EVERYWHERE}
        </button>
      </span>
      {open && (
        <PopupLayer>
          <div
            role="menu"
            data-search-field-menu
            ref={popup.ref}
            style={{
              ...popup.style,
              display: 'grid',
              gap: 4,
              justifyItems: 'stretch',
              minWidth: 220,
              maxHeight: 420,
              overflowY: 'auto',
              padding: 8,
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
            }}
          >
            <button
              type="button"
              data-search-field-option="all"
              onClick={() => {
                props.onSelect(null);
                setOpen(false);
              }}
              style={{
                textAlign: 'left',
                padding: '6px 8px',
                borderRadius: 6,
                border: 'none',
                background: !chosen ? 'rgba(37, 99, 235, 0.15)' : 'transparent',
                color: 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {SEARCH_FIELD_EVERYWHERE}
            </button>
            {groups.map((group) => (
              <div key={group.kind} style={{ display: 'grid', gap: 2 }}>
                {!singleGroup && (
                  <div style={{ padding: '4px 8px 0', fontSize: 11, color: 'var(--muted)' }}>{group.title}</div>
                )}
                {group.items.map((option) => {
                  const active = chosen?.kind === option.kind && chosen?.id === option.id;
                  return (
                    <button
                      key={`${option.kind}|${option.id}`}
                      type="button"
                      data-search-field-option={option.id}
                      data-search-field-kind={option.kind}
                      onClick={() => {
                        props.onSelect({ kind: option.kind, fieldId: option.id });
                        setOpen(false);
                      }}
                      style={{
                        textAlign: 'left',
                        padding: '6px 8px',
                        borderRadius: 6,
                        border: 'none',
                        background: active ? 'rgba(37, 99, 235, 0.15)' : 'transparent',
                        color: 'var(--text)',
                        cursor: 'pointer',
                      }}
                    >
                      {option.title}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </PopupLayer>
      )}
    </>
  );
}
