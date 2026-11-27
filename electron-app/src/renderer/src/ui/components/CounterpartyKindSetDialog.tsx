import React from 'react';

import { COUNTERPARTY_KIND_CHOICES, type CounterpartyKindChoice } from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * Выбор вида для простановки пачкой заказчикам.
 *
 * Отдельное окно, а не поле в строке: вид — признак заказа, и оператор
 * проставляет его сразу нескольким заказчикам (у парка вида нет почти ни у
 * кого, а отбор по виду без него пустой). Набор вариантов — общий с карточкой
 * заказчика (`COUNTERPARTY_KIND_CHOICES`), чтобы «проставить пачкой» и «поставить
 * в карточке» давали один и тот же результат.
 */
export function CounterpartyKindSetDialog(props: {
  open: boolean;
  /** Сколько заказчиков в пачке. */
  count: number;
  onClose: () => void;
  onPick: (choice: CounterpartyKindChoice) => void;
}) {
  if (!props.open) return null;
  const many = props.count > 1;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={props.onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface, #fff)',
          padding: 20,
          borderRadius: 10,
          maxWidth: 'min(96vw, 620px)',
          width: '96vw',
          border: '1px solid var(--border)',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14, gap: 12 }}>
          <h3 style={{ margin: 0 }}>Проставить вид {many ? `выделенным (${props.count})` : 'заказчику'}</h3>
          <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
            Вид отбирает заказчиков и двигатели: у кого вида нет, те отбираются по «Вид не задан»
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 12,
            marginBottom: 12,
          }}
        >
          {COUNTERPARTY_KIND_CHOICES.map((option) => (
            <button
              key={option.id}
              type="button"
              data-counterparty-kind-set-option={option.id}
              onClick={() => props.onPick(option.id)}
              style={{
                textAlign: 'left',
                padding: 12,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                cursor: 'pointer',
                fontSize: 15,
                fontWeight: 600,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--surface-hover, #f8fafc)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'var(--surface)';
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
        </div>
      </div>
    </div>
  );
}
