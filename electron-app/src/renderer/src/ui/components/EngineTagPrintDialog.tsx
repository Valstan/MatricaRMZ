import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { StatusCode } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { useListUiState } from '../hooks/useListBehavior.js';
import { useTagPrintQueue, type TagQueueItem } from '../hooks/useTagPrintQueue.js';
import {
  ENGINE_TAG_ORIENTATION_OPTIONS,
  ENGINE_TAG_PER_SHEET_OPTIONS,
  buildEngineTagsHtmlWithQr,
  openEngineTagsPrintHtml,
  type EngineTagData,
  type EngineTagOrientation,
  type EngineTagsPerSheet,
} from '../utils/engineTagPrint.js';

/**
 * Печать бирок на двигатель (владелец 22.09.2026, очередь — 01.10.2026).
 * Один диалог на два входа: оператор набирает двигатели галочками в списке и
 * кнопкой «Бирка» в карточках, а печатает одним заходом. Набор (очередь) живёт
 * в sessionStorage — закрытие диалога и hopping по карточкам его не убивают.
 *
 * Верх секции — очередь (галочка = в печать, снята = только в наборе, ✕ = вон)
 * и добор поиском по номеру; низ — раскладка и превью. Разметку листа и подбор
 * кеглей делает `engineTagPrint`; диалог отвечает за набор и раскладку.
 */

/** A4 в px @96dpi: лист рисуется в полную величину и ужимается `zoom` (как в диалогах наряда и табеля). */
const A4_PORTRAIT_PX = { width: Math.round((210 * 96) / 25.4), height: Math.round((297 * 96) / 25.4) };
const A4_LANDSCAPE_PX = { width: A4_PORTRAIT_PX.height, height: A4_PORTRAIT_PX.width };
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
 * `engineId` — для очереди (дедуп и снятие) и QR бирки (`engine:<id>`).
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

export type EngineTagInitial = EngineTagSource & { engineId: string };

/**
 * Поля бирки — из того, что уже есть в строке списка. Отдельного запроса на каждый
 * двигатель здесь нет: чего в строке нет, генератор напечатает прочерком.
 */
export function buildEngineTagData(e: EngineTagSource & { engineId?: string }): EngineTagData {
  // Дата начала ремонта — статусная дата стадии `status_repair_started` (в EAV она лежит
  // под `status_repair_started_date`, см. STATUS_DATE_CODES; в строке списка карта уже
  // разобрана по кодам стадий).
  return {
    engineBrand: String(e.engineBrand ?? ''),
    engineNumber: String(e.engineNumber ?? ''),
    engineId: String(e.engineId ?? ''),
    customerName: String(e.customerName ?? ''),
    contractNumber: String(e.contractName ?? ''),
    arrivalDate: e.arrivalDate ?? null,
    repairStartDate: e.statusDates?.status_repair_started ?? null,
    repairDueDate: e.repairDueDate ?? null,
  };
}

const ORIENTATION_LABEL: Record<EngineTagOrientation, string> = {
  landscape: 'Альбом',
  portrait: 'Портрет',
};

function normalizePerSheet(v: unknown): EngineTagsPerSheet {
  const n = Number(v);
  return ENGINE_TAG_PER_SHEET_OPTIONS.find((o) => o === n) ?? ENGINE_TAG_PER_SHEET_OPTIONS[0] ?? 6;
}

function normalizeOrientation(v: unknown): EngineTagOrientation {
  return ENGINE_TAG_ORIENTATION_OPTIONS.find((o) => o === v) ?? 'portrait';
}

function queueLabel(item: TagQueueItem): string {
  const brand = String(item.engineBrand ?? '').trim();
  const number = String(item.engineNumber ?? '').trim();
  const name = [brand, number].filter(Boolean).join(' ').trim();
  return name || `Без номера (${item.engineId.slice(0, 8)})`;
}

export function EngineTagPrintDialog(props: {
  open: boolean;
  title?: string;
  /** Набор, с которым диалог открывают (выделение списка / карточка). Добирается в очередь без дублей. */
  initial: ReadonlyArray<EngineTagInitial>;
  onClose: () => void;
}) {
  // Раскладку помним между вызовами: бирки печатают пачками, и каждый раз оператор
  // выбирал бы один и тот же вариант заново. Ключ общий для списка и карточки.
  // По умолчанию — портрет и 4 бирки (владелец 02.10.2026). Ключ новый (ui2):
  // у старого лежит сохранённый альбом-дефолт, неотличимый от осознанного выбора.
  const { state, patchState } = useListUiState<{ perSheet: number; orientation: EngineTagOrientation }>(
    'print:engineTags:ui2',
    { perSheet: 4, orientation: 'portrait' },
  );
  const perSheet = normalizePerSheet(state.perSheet);
  const orientation = normalizeOrientation(state.orientation);
  const previewPx = orientation === 'landscape' ? A4_LANDSCAPE_PX : A4_PORTRAIT_PX;
  const queue = useTagPrintQueue();
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<EngineTagInitial[]>([]);
  const [catalogError, setCatalogError] = useState('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Открытие добирает входной набор в очередь (без дублей) и подтягивает каталог
  // для добора поиском. Закрытый диалог ничего не грузит и не считает.
  useEffect(() => {
    if (!props.open) return;
    if (props.initial.length > 0) queue.enqueue([...props.initial]);
    setQuery('');
    setCatalogError('');
    let alive = true;
    void (async () => {
      try {
        const rows = await window.matrica.engines.list();
        const list = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>;
        if (!alive) return;
        setCatalog(
          list.map((e) => ({ ...(e as EngineTagSource), engineId: String(e.id ?? e.engineId ?? '') })).filter((e) => e.engineId),
        );
      } catch (e) {
        if (alive) setCatalogError(`Каталог не загрузился: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enqueue читает актуальную очередь сам; initial — снимок открытия
  }, [props.open]);

  const queuedIds = useMemo(() => new Set(queue.items.map((i) => i.engineId)), [queue.items]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return catalog
      .filter((e) => !queuedIds.has(e.engineId))
      .filter((e) => queueLabel({ ...e, checked: true }).toLowerCase().includes(q))
      .slice(0, 30);
  }, [query, catalog, queuedIds]);

  const checked = useMemo(() => queue.items.filter((i) => i.checked), [queue.items]);
  // Закрытый диалог лист не собирает: он висит смонтированным рядом со списком, и
  // перебирать очередь на каждый его рендер незачем.
  const tags = useMemo(() => (props.open ? checked.map(buildEngineTagData) : []), [props.open, checked]);
  // QR генерируется асинхронно (генератор — промис): превью и печать берут готовый HTML.
  const [html, setHtml] = useState('');
  useEffect(() => {
    if (!props.open || tags.length === 0) {
      setHtml('');
      return;
    }
    let alive = true;
    void buildEngineTagsHtmlWithQr(tags, { perSheet, orientation })
      .then((h) => {
        if (alive) setHtml(h);
      })
      .catch(() => {
        if (alive) setHtml('');
      });
    return () => {
      alive = false;
    };
  }, [props.open, tags, perSheet, orientation]);
  const sheets = tags.length > 0 ? Math.ceil(tags.length / perSheet) : 0;

  // Превью грузится через srcDoc асинхронно — высоту iframe подгоняем после загрузки,
  // иначе пачка в несколько листов обрезается первым.
  useEffect(() => {
    const t = setTimeout(() => {
      const doc = iframeRef.current?.contentWindow?.document;
      const h = doc?.body?.scrollHeight ?? 0;
      if (iframeRef.current) iframeRef.current.style.height = `${Math.max(h, previewPx.height) + 8}px`;
    }, 120);
    return () => clearTimeout(t);
  }, [html, previewPx.height]);

  if (!props.open) return null;

  async function handlePrint() {
    if (tags.length === 0) return;
    const h =
      html ||
      (await buildEngineTagsHtmlWithQr(tags, { perSheet, orientation }).catch(() => ''));
    if (!h) return;
    openEngineTagsPrintHtml(h);
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

          <div data-tag-queue>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>
              В очереди: <b>{queue.items.length}</b>, в печать: <b>{checked.length}</b>
            </div>
            {queue.items.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--subtle)' }}>Пусто — отметьте двигатели в списке или кнопкой «Бирка» в карточке.</div>
            ) : (
              <div style={{ display: 'grid', gap: 4, maxHeight: 180, overflowY: 'auto' }}>
                {queue.items.map((item) => (
                  <label key={item.engineId} data-tag-row={item.engineId} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={item.checked} data-tag-check={item.engineId} onChange={(e) => queue.setChecked(item.engineId, e.target.checked)} />
                    <span style={{ flex: 1 }}>{queueLabel(item)}</span>
                    <Button variant="ghost" title="Убрать из очереди" data-tag-remove={item.engineId} onClick={() => queue.remove(item.engineId)}>
                      ✕
                    </Button>
                  </label>
                ))}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Номер для добора…" data-tag-search />
            </div>
            {catalogError ? <div style={{ fontSize: 11, color: 'var(--danger)' }}>{catalogError}</div> : null}
            {matches.length > 0 && (
              <div style={{ display: 'grid', gap: 4, marginTop: 4, maxHeight: 140, overflowY: 'auto' }}>
                {matches.map((m) => (
                  <div key={m.engineId} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                    <span style={{ flex: 1 }}>{queueLabel({ ...m, checked: true })}</span>
                    <Button variant="ghost" title="Добавить в очередь" data-tag-add={m.engineId} onClick={() => queue.enqueue([m])}>
                      +
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--subtle)', marginTop: 4 }}>
              Можно закрыть, добрать двигатели и вернуться — набор сохранится.
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, color: 'var(--subtle)', marginBottom: 4 }}>Ориентация листа</div>
            <div style={{ display: 'flex', border: '1px solid var(--input-border, var(--border))', borderRadius: 8, overflow: 'hidden' }}>
              {ENGINE_TAG_ORIENTATION_OPTIONS.map((o, i) => (
                <button
                  key={o}
                  type="button"
                  data-engine-tags-orientation={o}
                  onClick={() => patchState({ orientation: o })}
                  style={{
                    flex: 1,
                    padding: '7px 0',
                    fontSize: 13,
                    cursor: 'pointer',
                    border: 'none',
                    borderLeft: i === 0 ? 'none' : '1px solid var(--input-border, var(--border))',
                    background: orientation === o ? 'var(--tone-info-bg, #dbeafe)' : 'transparent',
                    color: orientation === o ? 'var(--tone-info-text, #1d4ed8)' : 'inherit',
                    fontWeight: orientation === o ? 700 : 400,
                  }}
                >
                  {ORIENTATION_LABEL[o]}
                </button>
              ))}
            </div>
          </div>

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
              Двигателей в печати: <b>{tags.length}</b>
            </div>
            <div>
              Листов к печати: <b>{sheets}</b>
            </div>
          </div>

          <div style={{ fontSize: 11, color: 'var(--subtle)' }}>
            Бирки растянуты на весь лист. Чего нет в карточке — на бирке стоит прочерк.
          </div>

          <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button variant="primary" onClick={handlePrint} disabled={tags.length === 0} data-tag-print>
              {sheets === 1 ? 'Печать (1 лист)' : `Печать (${sheets} л.)`}
            </Button>
            <Button variant="ghost" onClick={props.onClose}>
              Закрыть
            </Button>
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', background: '#e7e9ef', borderRadius: 8, padding: 8 }}>
          <div style={{ width: previewPx.width * PREVIEW_SCALE }}>
            <iframe
              ref={iframeRef}
              title="Превью листа с бирками"
              srcDoc={html + PREVIEW_CHROME_CSS}
              style={{ width: previewPx.width, height: previewPx.height, border: 'none', zoom: PREVIEW_SCALE, background: 'transparent' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
