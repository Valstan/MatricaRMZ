import React from 'react';

/** Допустимые размеры страницы для списков склада (номенклатура, остатки, документы). */
export const WAREHOUSE_LIST_PAGE_SIZES = [25, 50, 100] as const;
export type WarehouseListPageSize = (typeof WAREHOUSE_LIST_PAGE_SIZES)[number];

type Props = {
  pageSize: WarehouseListPageSize;
  onPageSizeChange: (size: WarehouseListPageSize) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  rowCount: number;
  hasMore: boolean;
  disabled?: boolean;
};

export function WarehouseListPager(props: Props) {
  const { pageSize, onPageSizeChange, pageIndex, onPageIndexChange, rowCount, hasMore, disabled } = props;
  const from = rowCount === 0 ? 0 : pageIndex * pageSize + 1;
  const to = pageIndex * pageSize + rowCount;
  const canPrev = pageIndex > 0;
  const canNext = hasMore;

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        fontSize: 13,
        color: 'var(--subtle)',
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        На странице
        <select
          value={pageSize}
          disabled={disabled}
          onChange={(e) => onPageSizeChange(Number(e.target.value) as WarehouseListPageSize)}
          style={{ padding: '4px 8px', minWidth: 70 }}
        >
          {WAREHOUSE_LIST_PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span>
        Записи {from === 0 && rowCount === 0 ? '0' : `${from}–${to}`}
        {hasMore ? ' (есть ещё)' : ''}
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          disabled={disabled || !canPrev}
          onClick={() => onPageIndexChange(pageIndex - 1)}
          style={{
            padding: '4px 10px',
            opacity: canPrev && !disabled ? 1 : 0.45,
            cursor: canPrev && !disabled ? 'pointer' : 'not-allowed',
          }}
        >
          Назад
        </button>
        <button
          type="button"
          disabled={disabled || !canNext}
          onClick={() => onPageIndexChange(pageIndex + 1)}
          style={{
            padding: '4px 10px',
            opacity: canNext && !disabled ? 1 : 0.45,
            cursor: canNext && !disabled ? 'pointer' : 'not-allowed',
          }}
        >
          Вперёд
        </button>
      </div>
      <span style={{ color: 'var(--subtle)' }}>Страница {pageIndex + 1}</span>
    </div>
  );
}
