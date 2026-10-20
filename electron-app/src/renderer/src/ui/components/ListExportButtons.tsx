import React, { useState } from 'react';
import { createPortal } from 'react-dom';

import type { ListExportFormat } from '@matricarmz/shared';

import { isAndroidPlatform } from '../platform.js';
import { resolvePrintColumnIds } from '../utils/listColumnSelection.js';
import { planListPrintLayout } from '../utils/listPrintLayout.js';
import { buildListExportSpec } from '../utils/listExportSpec.js';
import { listToText } from '../utils/mailText.js';
import { formatMomentLabel } from '../utils/printPreview.js';
import { Button } from './Button.js';
import type { ListPrintColumn } from './ListPrintDialog.js';
import { MailSendButton } from './MailSendButton.js';

/** Сколько строк меряем, чтобы предположить ширины колонок в Word: дальше значения не меняют картину. */
const LAYOUT_SAMPLE_ROWS = 200;
/** Порог, за которым спрашиваем подтверждение: файл такого объёма собирается и открывается небыстро. */
const BIG_EXPORT_ROWS = 10_000;

function pluralRows(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'строка';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'строки';
  return 'строк';
}

/**
 * Выгрузка списка в Excel и Word — рядом с «Печать списка», из того же модельного слоя:
 * колонки те же, что печатаются (общее хранение выбора — `listColumnSelection.ts`), строки —
 * текущий отбор, «№» первой. Файл собирает main-процесс (`listExportService.ts`); сюда
 * возвращается только путь — папку оператор выбирает в «Сохранить как», и она запоминается.
 *
 * По умолчанию выгружается выделение, если оно есть, — как в печати. Подтверждение на
 * большой объём не ритуал: список на десятки тысяч строк рендерер передаёт в main целиком,
 * и на слабой машине это заметная пауза.
 */
export function ListExportButtons<T>(props: {
  title: string;
  columns: ListPrintColumn<T>[];
  visibleColumnIds: string[];
  rows: T[];
  selectedRows: T[];
  /** Тот же ключ, что у диалога печати: печатается и выгружается один набор колонок. */
  storageKey: string;
  filtersSummary?: string[];
  fileBaseName?: string;
  /** Страницы отчётов держат выгрузку под правом `reports.export` — там оно приходит сюда. */
  enabled?: boolean;
}) {
  const [busy, setBusy] = useState<ListExportFormat | null>(null);
  const [pending, setPending] = useState<{ format: ListExportFormat; count: number } | null>(null);

  // На планшете выгрузка в Word/Excel не поддерживается: кнопки, которые не могут работать,
  // хуже их отсутствия.
  if (props.enabled === false || isAndroidPlatform()) return null;

  const columnIds = resolvePrintColumnIds({
    storageKey: props.storageKey,
    columns: props.columns,
    visibleColumnIds: props.visibleColumnIds,
  });
  const fields = props.columns.filter((c) => columnIds.includes(c.id));
  const scopeRows = props.selectedRows.length > 0 ? props.selectedRows : props.rows;
  const canExport = fields.length > 0 && scopeRows.length > 0 && busy === null;

  /** Один и тот же лист уходит и в файл, и в письмо: письмо не описывает список второй раз. */
  const buildSpec = () => {
    const sample = scopeRows.slice(0, LAYOUT_SAMPLE_ROWS);
    const plan = planListPrintLayout({
      columns: fields.map((field) => ({
        label: field.label,
        valueChars: sample.reduce((max, row) => Math.max(max, field.printValue(row).length), 0),
      })),
    });
    return buildListExportSpec({
      title: props.title,
      fields,
      rows: scopeRows,
      filters: props.filtersSummary ?? [],
      columnWidthsMm: plan.widthsMm,
      meta: `Выгружено: ${formatMomentLabel(new Date())}`,
      ...(props.fileBaseName ? { fileBaseName: props.fileBaseName } : {}),
    });
  };

  const run = async (format: ListExportFormat) => {
    setPending(null);
    setBusy(format);
    try {
      // Ошибку оператору показывает main: он единственный, кто видит причину целиком,
      // и его окно не зависит от того, уехали ли кнопки в меню переполнения.
      await window.matrica.exports.list({ format, spec: buildSpec() });
    } finally {
      setBusy(null);
    }
  };

  const start = (format: ListExportFormat) => {
    if (!canExport) return;
    if (scopeRows.length > BIG_EXPORT_ROWS) {
      setPending({ format, count: scopeRows.length });
      return;
    }
    void run(format);
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Button
        variant="ghost"
        disabled={!canExport}
        onClick={() => start('xlsx')}
        data-list-export="xlsx"
        title="Выгрузить список в Excel: те же колонки и отбор, что на экране"
      >
        {busy === 'xlsx' ? 'Готовим…' : 'В Excel'}
      </Button>
      <Button
        variant="ghost"
        disabled={!canExport}
        onClick={() => start('docx')}
        data-list-export="docx"
        title="Выгрузить список в Word: тот же лист, что печатается"
      >
        {busy === 'docx' ? 'Готовим…' : 'В Word'}
      </Button>
      <MailSendButton
        subject={`${props.title} — Матрица`}
        summary={[
          props.title,
          `${scopeRows.length} ${pluralRows(scopeRows.length)}`,
          ...(props.filtersSummary ?? []),
        ]}
        body={listToText(fields, scopeRows)}
        attachment={() => ({ kind: 'list', format: 'docx', spec: buildSpec() })}
        disabled={!canExport}
      />
      {pending
        ? createPortal(
            <div
              onClick={() => setPending(null)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.4)',
                zIndex: 1200,
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                padding: 24,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: 'var(--card-bg, #fff)',
                  color: 'var(--text)',
                  borderRadius: 12,
                  padding: 16,
                  width: 'min(460px, 96vw)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                  boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 16 }}>
                  {pending.count} {pluralRows(pending.count)} — это большой файл
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                  Сборка займёт время, а Excel или Word на слабой машине будут открывать его небыстро.
                  <br />
                  Если нужен не весь список — закройте окно и примените фильтр в списке или выделите нужные строки.
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <Button variant="ghost" onClick={() => setPending(null)}>
                    Вернуться и уточнить
                  </Button>
                  <Button onClick={() => void run(pending.format)}>Всё равно выгрузить</Button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
