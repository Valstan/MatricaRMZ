import React, { useEffect, useMemo, useRef } from 'react';

import type { StatusCode } from '@matricarmz/shared';

import { Button } from './Button.js';
import { useListUiState } from '../hooks/useListBehavior.js';
import {
  ENGINE_TAG_PER_SHEET_OPTIONS,
  buildEngineTagsHtml,
  openEngineTagsPrint,
  type EngineTagData,
  type EngineTagsPerSheet,
} from '../utils/engineTagPrint.js';

/**
 * Печать бирок на двигатель (владелец 22.09.2026). Оператор выбирает раскладку —
 * 6 / 4 / 2 бирки на лист A4 — и видит готовый лист до печати. Разметку листа и подбор
 * кеглей делает `engineTagPrint`; диалог отвечает только за выбор раскладки и за то,
 * откуда берутся поля бирки.
 */

/** A4 портрет в px @96dpi: лист рисуется в полную величину и ужимается `zoom` (как в диалогах наряда и табеля). */
const A4_WIDTH_PX = Math.round((210 * 96) / 25.4); // ≈ 794
const A4_HEIGHT_PX = Math.round((297 * 96) / 25.4); // ≈ 1123
const PREVIEW_SCALE = 0.56;

/**
 * В превью служебная шапка окна печати не нужна: своя кнопка печати стоит рядом, а две
 * кнопки рядом читаются как выбор. Правило дописывается ПОСЛЕ документа генератора —
 * так превью не расходится с печатной формой ни на строку.
 */
const PREVIEW_CHROME_CSS = '<style>.no-print { display: none !important; }</style>';

const PER_SHEET_HINT: Record<EngineTagsPerSheet, string> = {
  6: 'мелко — пачка двигателей на один лист',
  4: 'средне',
  2: 'крупно — читается издалека',
};

/**
 * Откуда диалог берёт бирку. Структурный тип, а не `Pick<EngineListItem>`: карточка
 * двигателя строки списка не имеет и собирает те же поля из своего состояния.
 */
export type EngineTagSource = {
  engineBrand?: string;
  engineNumber?: string;
  customerName?: string;
  /** Номер договора целиком — у строки списка это отображаемое имя контракта. */
  contractName?: string;
  arrivalDate?: number | null;
  /** Крайний день ремонта по договору: в списке его считает `listEngines` (поступление + `effectiveRepairDays`). */
  repairDueDate?: number | null;
  statusDates?: Partial<Record<StatusCode, number | null>>;
};

/**
 * Поля бирки — из того, что уже есть в строке списка. Отдельного запроса на каждый
 * двигатель здесь нет: чего в строке нет, генератор напечатает прочерком.
 */
export function buildEngineTagData(e: EngineTagSource): EngineTagData {
  // Дата начала ремонта — статусная дата стадии `status_repair_started` (в EAV она лежит
  // под `status_repair_started_date`, см. STATUS_DATE_CODES; в строке списка карта уже
  // разобрана по кодам стадий).
  return {
    engineBrand: String(e.engineBrand ?? ''),
    engineNumber: String(e.engineNumber ?? ''),
    customerName: String(e.customerName ?? ''),
    contractNumber: String(e.contractName ?? ''),
    arrivalDate: e.arrivalDate ?? null,
    repairStartDate: e.statusDates?.status_repair_started ?? null,
    repairDueDate: e.repairDueDate ?? null,
  };
}

function normalizePerSheet(v: unknown): EngineTagsPerSheet {
  const n = Number(v);
  return ENGINE_TAG_PER_SHEET_OPTIONS.find((o) => o === n) ?? ENGINE_TAG_PER_SHEET_OPTIONS[0] ?? 6;
}

export function EngineTagPrintDialog(props: {
  open: boolean;
  title?: string;
  engines: ReadonlyArray<EngineTagSource>;
  onClose: () => void;
}) {
  // Раскладку помним между вызовами: бирки печатают пачками, и каждый раз оператор
  // выбирал бы один и тот же вариант заново. Ключ общий для списка и карточки.
  const { state, patchState } = useListUiState<{ perSheet: number }>('print:engineTags:ui', { perSheet: 6 });
  const perSheet = normalizePerSheet(state.perSheet);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Закрытый диалог лист не собирает: он висит смонтированным рядом со списком, и
  // перебирать выделение на каждый его рендер незачем.
  const tags = useMemo(() => (props.open ? props.engines.map(buildEngineTagData) : []), [props.open, props.engines]);
  const html = useMemo(() => (props.open ? buildEngineTagsHtml(tags, { perSheet }) : ''), [props.open, tags, perSheet]);
  const sheets = tags.length > 0 ? Math.ceil(tags.length / perSheet) : 0;

  // Превью грузится через srcDoc асинхронно — высоту iframe подгоняем после загрузки,
  // иначе пачка в несколько листов обрезается первым.
  useEffect(() => {
    const t = setTimeout(() => {
      const doc = iframeRef.current?.contentWindow?.document;
      const h = doc?.body?.scrollHeight ?? 0;
      if (iframeRef.current) iframeRef.current.style.height = `${Math.max(h, A4_HEIGHT_PX) + 8}px`;
    }, 120);
    return () => clearTimeout(t);
  }, [html]);

  if (!props.open) return null;

  function handlePrint() {
    if (tags.length === 0) return;
    openEngineTagsPrint(tags, { perSheet });
    props.onClose();
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          background: 'var(--surface, #fff)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 18,
          display: 'flex',
          gap: 18,
          width: 'min(97vw, 1020px)',
          maxHeight: '94vh',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
        }}
      >
        <div style={{ flex: '0 0 250px', width: 250, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{props.title ?? 'Печать бирок на двигатели'}</div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>Бирок на лист A4</div>
            <div style={{ display: 'flex', border: '1px solid var(--input-border, var(--border))', borderRadius: 8, overflow: 'hidden' }}>
              {ENGINE_TAG_PER_SHEET_OPTIONS.map((n, i) => (
                <button
                  key={n}
                  type="button"
                  data-engine-tags-per-sheet={n}
                  onClick={() => patchState({ perSheet: n })}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    fontSize: 13,
                    cursor: 'pointer',
                    border: 'none',
                    borderLeft: i === 0 ? 'none' : '1px solid var(--input-border, var(--border))',
                    background: perSheet === n ? 'var(--tone-info-bg, #dbeafe)' : 'transparent',
                    color: perSheet === n ? 'var(--tone-info-text, #1d4ed8)' : 'inherit',
                    fontWeight: perSheet === n ? 700 : 400,
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 4 }}>{PER_SHEET_HINT[perSheet]}</div>
          </div>

          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>
              Двигателей выбрано: <b>{tags.length}</b>
            </div>
            <div>
              Листов к печати: <b>{sheets}</b>
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--subtle)' }}>
            Бирки растянуты на весь лист. Чего нет в карточке — на бирке стоит прочерк.
          </div>

          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button variant="primary" onClick={handlePrint} disabled={tags.length === 0}>
              {sheets === 1 ? 'Печать (1 лист)' : `Печать (${sheets} л.)`}
            </Button>
            <Button variant="ghost" onClick={props.onClose}>
              Закрыть
            </Button>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: '#e7e9ef', borderRadius: 8, padding: 8 }}>
          <div style={{ width: A4_WIDTH_PX * PREVIEW_SCALE }}>
            <iframe
              ref={iframeRef}
              title="Превью листа с бирками"
              srcDoc={html + PREVIEW_CHROME_CSS}
              style={{ width: A4_WIDTH_PX, height: A4_HEIGHT_PX, border: 'none', zoom: PREVIEW_SCALE, background: 'transparent' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
