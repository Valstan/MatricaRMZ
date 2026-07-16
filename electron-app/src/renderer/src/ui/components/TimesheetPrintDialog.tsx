import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  TIMESHEET_PRINT_FONT_DEFAULTS,
  TIMESHEET_PRINT_FONT_RANGES,
  type TimesheetPrintSettings,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { FontStepper } from './WorkOrderPrintDialog.js';
import { loadTimesheetPrintSettings, saveTimesheetPrintSettings } from '../utils/timesheetPrintSettings.js';

/** A4 landscape в px @96dpi: страница 297×210мм. */
const A4L_WIDTH_PX = Math.round((297 * 96) / 25.4); // ≈ 1123
const A4L_HEIGHT_PX = Math.round((210 * 96) / 25.4); // ≈ 794
const PREVIEW_SCALE = 0.62;

export type TimesheetPrintVariant = 'full' | 'first' | 'second';

/** Какие блоки выводить на печать (все отключаемые галочками). */
export type TimesheetPrintBlocks = { header: boolean; grid: boolean; legend: boolean; decode: boolean };

const BLOCK_ROWS: Array<{ key: keyof TimesheetPrintBlocks; label: string; hint?: string }> = [
  { key: 'header', label: 'Шапка листа' },
  { key: 'grid', label: 'Таблица табеля' },
  { key: 'legend', label: 'Легенда кодов' },
  { key: 'decode', label: 'Комментарии по сотрудникам', hint: 'отдельным листом' },
];

type FontKey = 'fontHeader' | 'fontFio' | 'fontDayNum' | 'fontWeekday' | 'fontCell' | 'fontLegend';
const FONT_ROWS: Array<{ key: FontKey; label: string; hint?: string; range: { min: number; max: number }; def: number }> = [
  { key: 'fontHeader', label: 'Шапка листа', hint: 'название, месяц, цех', range: TIMESHEET_PRINT_FONT_RANGES.header, def: TIMESHEET_PRINT_FONT_DEFAULTS.header },
  { key: 'fontFio', label: 'ФИО сотрудников', range: TIMESHEET_PRINT_FONT_RANGES.fio, def: TIMESHEET_PRINT_FONT_DEFAULTS.fio },
  { key: 'fontCell', label: 'Цифры в ячейках', hint: 'часы и коды дней', range: TIMESHEET_PRINT_FONT_RANGES.cell, def: TIMESHEET_PRINT_FONT_DEFAULTS.cell },
  { key: 'fontDayNum', label: 'Числа месяца', hint: 'шапка колонок 1..31', range: TIMESHEET_PRINT_FONT_RANGES.dayNum, def: TIMESHEET_PRINT_FONT_DEFAULTS.dayNum },
  { key: 'fontWeekday', label: 'Дни недели', hint: 'пн/вт под числами', range: TIMESHEET_PRINT_FONT_RANGES.weekday, def: TIMESHEET_PRINT_FONT_DEFAULTS.weekday },
  { key: 'fontLegend', label: 'Легенда и расшифровки', range: TIMESHEET_PRINT_FONT_RANGES.legend, def: TIMESHEET_PRINT_FONT_DEFAULTS.legend },
];

export function TimesheetPrintDialog(props: {
  /** Standalone A4-landscape HTML (с #wo-a4) для iframe-превью по настройкам, варианту и блокам. */
  buildHtml: (settings: TimesheetPrintSettings, variant: TimesheetPrintVariant, blocks: TimesheetPrintBlocks) => string;
  onPrint: (settings: TimesheetPrintSettings, variant: TimesheetPrintVariant, blocks: TimesheetPrintBlocks) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TimesheetPrintSettings>(() => loadTimesheetPrintSettings());
  const [variant, setVariant] = useState<TimesheetPrintVariant>('full');
  const [blocks, setBlocks] = useState<TimesheetPrintBlocks>({ header: true, grid: true, legend: true, decode: false });
  const [pages, setPages] = useState(1);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const html = useMemo(() => props.buildHtml(draft, variant, blocks), [props.buildHtml, draft, variant, blocks]);

  function update(patch: Partial<TimesheetPrintSettings>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function measure() {
    const doc = iframeRef.current?.contentWindow?.document;
    const el = doc?.getElementById('wo-a4');
    if (!el) return;
    setPages(Math.max(1, Math.ceil(el.scrollHeight / A4L_HEIGHT_PX)));
    if (iframeRef.current) iframeRef.current.style.height = `${Math.max(el.scrollHeight, A4L_HEIGHT_PX) + 8}px`;
  }

  // Пересчёт страниц после каждого обновления превью (srcDoc грузится асинхронно).
  useEffect(() => {
    const t = setTimeout(measure, 120);
    return () => clearTimeout(t);
  }, [html]);

  // Комментарии идут отдельным листом (page-break) — допустимый максимум страниц на 1 больше.
  const pageLimit = blocks.decode ? 2 : 1;
  const fits = pages <= pageLimit;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 18,
          display: 'flex',
          gap: 18,
          width: 'min(97vw, 1180px)',
          maxHeight: '94vh',
        }}
      >
        <div style={{ flex: '0 0 250px', width: 250, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Настройка печати табеля</div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>Вариант</div>
            <div style={{ display: 'flex', border: '1px solid var(--input-border)', borderRadius: 8, overflow: 'hidden' }}>
              {(
                [
                  { key: 'full', label: 'Месяц' },
                  { key: 'first', label: '1–15' },
                  { key: 'second', label: '16–кон.' },
                ] as Array<{ key: TimesheetPrintVariant; label: string }>
              ).map((v, i) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setVariant(v.key)}
                  style={{
                    flex: 1,
                    padding: '7px 6px',
                    border: 'none',
                    borderLeft: i === 0 ? 'none' : '1px solid var(--input-border)',
                    background: variant === v.key ? 'var(--button-primary-bg)' : 'var(--input-bg)',
                    color: variant === v.key ? 'var(--button-primary-text)' : 'var(--text)',
                    cursor: 'pointer',
                    fontSize: 12,
                  }}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>Блоки на печать</div>
            <div style={{ display: 'grid', gap: 4 }}>
              {BLOCK_ROWS.map((b) => (
                <label key={b.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={blocks[b.key]}
                    onChange={(e) => setBlocks((prev) => ({ ...prev, [b.key]: e.target.checked }))}
                  />
                  {b.label}
                  {b.hint ? <span style={{ fontSize: 11, color: 'var(--subtle)' }}>({b.hint})</span> : null}
                </label>
              ))}
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--subtle)', marginTop: 2 }}>Размеры шрифтов (px)</div>
          <div style={{ display: 'grid', gap: 8 }}>
            {FONT_ROWS.map((row) => (
              <FontStepper
                key={row.key}
                label={row.label}
                {...(row.hint ? { hint: row.hint } : {})}
                value={draft[row.key] ?? row.def}
                min={row.range.min}
                max={row.range.max}
                onChange={(v) => update({ [row.key]: v })}
              />
            ))}
          </div>

          <Button
            variant="ghost"
            onClick={() => setDraft((prev) => {
              const next = { ...prev };
              for (const row of FONT_ROWS) delete next[row.key];
              return next;
            })}
          >
            Сбросить шрифты
          </Button>

          <div style={{ fontSize: 13, fontWeight: 700, color: fits ? '#15803d' : '#b45309' }}>
            {fits ? `✓ Помещается на ${pageLimit === 1 ? '1 страницу' : `${pageLimit} страницы`}` : `Страниц: ${pages} — уменьшите шрифты`}
          </div>

          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button
              variant="primary"
              onClick={() => {
                saveTimesheetPrintSettings(draft);
                props.onPrint(draft, variant, blocks);
              }}
            >
              Печать…
            </Button>
            <Button variant="ghost" onClick={props.onClose}>Закрыть</Button>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: '#e7e9ef', borderRadius: 8, padding: 8 }}>
          <div style={{ width: A4L_WIDTH_PX * PREVIEW_SCALE }}>
            <iframe
              ref={iframeRef}
              title="Превью табеля"
              srcDoc={html}
              onLoad={measure}
              style={{ width: A4L_WIDTH_PX, height: A4L_HEIGHT_PX, border: 'none', zoom: PREVIEW_SCALE, background: 'transparent' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
