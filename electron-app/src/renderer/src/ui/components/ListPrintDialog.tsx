import React, { useMemo, useState } from 'react';

import { Button } from './Button.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

export type ListPrintColumn<T> = {
  id: string;
  label: string;
  /** Печатное представление ячейки. Печать берёт текст, а не разметку списка. */
  printValue: (row: T) => string;
};

/**
 * Печатная область A4 при полях 12мм — 273мм ≈ 1032px, строка таблицы при кегле 12px и
 * отступах 6px ≈ 28px (см. PRINT_BASE_CSS). На первой странице ещё уходит заголовок с шапкой.
 * Число приблизительное и подписано таковым: браузер разложит по-своему, но порядок величины
 * («две страницы» против «шестидесяти») оно передаёт честно, а именно это и нужно оператору.
 */
const ROWS_PER_PAGE = 34;

/** Больше этого — спрашиваем подтверждение: дальше начинается лоток бумаги, а не список. */
const PAGES_WARN_THRESHOLD = 10;

function pluralPages(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'лист';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'листа';
  return 'листов';
}

function loadColumnIds(storageKey: string, fallback: string[], known: Set<string>): string[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const ids = parsed.map((v) => String(v)).filter((id) => known.has(id));
    return ids.length > 0 ? ids : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Печать текущего списка: состав колонок, объём и предупреждение об объёме.
 *
 * По умолчанию печатаются ровно те колонки, что видны на экране — оператор настроил список
 * под себя, и печать не должна приносить обратно то, что он убрал. Набор можно поправить
 * здесь же, и правка запоминается отдельно от экранной раскладки: «посмотреть» и
 * «распечатать» — разные задачи с разными наборами полей.
 */
export function ListPrintDialog<T>(props: {
  title: string;
  /** Родительный падеж для счётчика: «двигателей», «нарядов». */
  unitLabel: string;
  columns: ListPrintColumn<T>[];
  visibleColumnIds: string[];
  rows: T[];
  selectedRows: T[];
  storageKey: string;
  onClose: () => void;
}) {
  const knownIds = useMemo(() => new Set(props.columns.map((c) => c.id)), [props.columns]);
  const defaultIds = useMemo(() => {
    const visible = props.visibleColumnIds.filter((id) => knownIds.has(id));
    return visible.length > 0 ? visible : props.columns.slice(0, 5).map((c) => c.id);
  }, [props.visibleColumnIds, props.columns, knownIds]);

  const [columnIds, setColumnIds] = useState<string[]>(() => loadColumnIds(props.storageKey, defaultIds, knownIds));
  const hasSelection = props.selectedRows.length > 0;
  const [scope, setScope] = useState<'selected' | 'all'>(hasSelection ? 'selected' : 'all');
  const [limitEnabled, setLimitEnabled] = useState(false);
  const [limitText, setLimitText] = useState('100');
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null);

  const scopeRows = scope === 'selected' && hasSelection ? props.selectedRows : props.rows;
  const limit = Math.max(1, Math.trunc(Number(limitText) || 0));
  const rows = limitEnabled && Number.isFinite(limit) ? scopeRows.slice(0, limit) : scopeRows;

  const fields = props.columns.filter((c) => columnIds.includes(c.id));
  const pages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const canPrint = fields.length > 0 && rows.length > 0;

  const toggleColumn = (id: string) => {
    setColumnIds((prev) => {
      const next = prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id];
      try {
        window.localStorage.setItem(props.storageKey, JSON.stringify(next));
      } catch {
        // localStorage недоступен — просто не запоминаем выбор
      }
      return next;
    });
  };

  const emit = () => {
    const thead = fields.map((f) => `<th>${escapeHtml(f.label)}</th>`).join('');
    const tbody = rows
      .map((row) => `<tr>${fields.map((f) => `<td>${escapeHtml(f.printValue(row) || '—')}</td>`).join('')}</tr>`)
      .join('');
    openPrintPreview({
      title: props.title,
      subtitle: `${props.unitLabel}: ${rows.length}${rows.length < scopeRows.length ? ` из ${scopeRows.length}` : ''}`,
      sections: [
        {
          id: 'list',
          title: props.title,
          hideTitle: true,
          html: `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
<div class="muted" style="margin-top:8px">Итого: ${rows.length}</div>`,
        },
      ],
    });
    props.onClose();
  };

  const requestPrint = () => {
    if (!canPrint) return;
    if (pages > PAGES_WARN_THRESHOLD) {
      setPendingConfirm(pages);
      return;
    }
    emit();
  };

  if (pendingConfirm != null) {
    return (
      <Backdrop onClose={props.onClose}>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Это примерно {pendingConfirm} {pluralPages(pendingConfirm)}</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            На печать уйдёт {rows.length} строк — это около {pendingConfirm} {pluralPages(pendingConfirm)} бумаги.
            Уверены, что нужен такой объём?
            <br />
            <br />
            Если нет — вернитесь и сократите: примените фильтр в списке, выделите нужные строки
            или ограничьте число строк здесь же.
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <Button onClick={() => setPendingConfirm(null)}>Вернуться и уточнить</Button>
            <Button variant="ghost" onClick={emit}>
              Всё равно печатать
            </Button>
          </div>
        </div>
      </Backdrop>
    );
  }

  return (
    <Backdrop onClose={props.onClose}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 16px',
          borderBottom: '1px solid rgba(15,23,42,0.12)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>Печать: {props.title.toLowerCase()}</div>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={props.onClose}>
          Закрыть
        </Button>
      </div>

      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontWeight: 600 }}>Что печатать</div>
          {hasSelection ? (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} />
              Только выделенные ({props.selectedRows.length})
            </label>
          ) : null}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
            Весь список по текущему фильтру ({props.rows.length})
          </label>
          {hasSelection ? null : (
            <div className="muted" style={{ fontSize: 12 }}>
              Чтобы напечатать только часть — выделите строки в списке (Shift+клик) или примените фильтр.
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={limitEnabled} onChange={(e) => setLimitEnabled(e.target.checked)} />
            Ограничить число строк
          </label>
          {limitEnabled ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 22 }}>
              <span style={{ fontSize: 13 }}>первые</span>
              <input
                type="number"
                min={1}
                value={limitText}
                onChange={(e) => setLimitText(e.target.value)}
                style={{ width: 90, padding: '4px 6px' }}
              />
              <span style={{ fontSize: 13 }}>строк — в том порядке, что на экране</span>
            </div>
          ) : null}
        </div>

        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            Колонки ({fields.length} из {props.columns.length})
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            По умолчанию — те же, что показаны в списке.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, maxHeight: 240, overflowY: 'auto' }}>
            {props.columns.map((c) => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={columnIds.includes(c.id)} onChange={() => toggleColumn(c.id)} />
                {c.label}
              </label>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            borderRadius: 8,
            background: pages > PAGES_WARN_THRESHOLD ? 'rgba(220,38,38,0.10)' : 'rgba(15,23,42,0.05)',
            fontSize: 13,
          }}
        >
          <span>
            К печати: <b>{rows.length}</b> строк — примерно <b>{pages}</b> {pluralPages(pages)}
          </span>
          {pages > PAGES_WARN_THRESHOLD ? <span style={{ color: '#b91c1c' }}>— много, спросим подтверждение</span> : null}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
          <Button onClick={requestPrint} disabled={!canPrint}>
            Печать…
          </Button>
        </div>
      </div>
    </Backdrop>
  );
}

function Backdrop(props: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 24,
        overflow: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--card-bg, #fff)',
          color: 'var(--text)',
          borderRadius: 12,
          width: 'min(560px, 96vw)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
        }}
      >
        {props.children}
      </div>
    </div>
  );
}
