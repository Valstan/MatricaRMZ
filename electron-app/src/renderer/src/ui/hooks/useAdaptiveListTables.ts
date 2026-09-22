import { useEffect } from 'react';

import { perfTrace } from '../utils/perfTrace.js';
import {
  RECALC_DELAY_MS,
  SCROLL_QUIET_MS,
  shouldDeferScan,
  shouldRecalcListTables,
  shouldWriteValue,
} from './domScanGating.js';

const LIST_COLUMNS_MODE_STORAGE_KEY = 'matrica:listColumnsMode';
const LIST_COLUMNS_MODE_CHANGED_EVENT = 'matrica:list-columns-mode-changed';

function clamp(n: number, min: number, max: number) {
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(clamp(q, 0, 1) * (sorted.length - 1));
  return sorted[idx] ?? 0;
}

function normalizeText(value: string) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readNumberCssVar(root: HTMLElement, name: string, fallback: number): number {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isSingleListMode() {
  try {
    return window?.localStorage?.getItem(LIST_COLUMNS_MODE_STORAGE_KEY) !== 'multi';
  } catch {
    return true;
  }
}

function isMostlyNumeric(value: string) {
  const text = normalizeText(value);
  if (!text) return false;
  const stripped = text.replace(/[\s.,:%/\\\-+()]/g, '');
  if (!stripped) return false;
  const digits = stripped.replace(/\D/g, '').length;
  return digits / stripped.length >= 0.75;
}

function recalcAdaptiveTableColumns() {
  const root = document.documentElement;
  const singleMode = isSingleListMode();
  const textMaxCh = clamp(readNumberCssVar(root, '--ui-list-text-max-ch', 100), 24, 100);
  const modeAttr = singleMode ? 'single' : 'multi';
  if (root.dataset.uiListColumnsMode !== modeAttr) root.dataset.uiListColumnsMode = modeAttr;
  // Только видимая панель: замер 240 строк × колонки по каждой таблице слишком дорог,
  // чтобы гонять его ещё и по скрытым вкладкам keep-alive.
  const scope = document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const tables = Array.from(scope.querySelectorAll('table.list-table')) as HTMLTableElement[];
  for (const table of tables) {
    const wrapper = table.parentElement;
    if (wrapper) {
      wrapper.classList.add('list-table-wrap');
      wrapper.classList.toggle('list-table-wrap--single', singleMode);
    }
    table.classList.toggle('list-table--single-mode', singleMode);

    // Ширины сводим в план и в конце сверяем с тем, что уже стоит на таблице: раньше все
    // двадцать переменных снимались и ставились заново на каждый пересчёт, а каждая такая
    // запись гасит раскладку таблицы целиком.
    const plannedMaxCh = new Map<number, string>();
    if (!singleMode) recalcTableColumnPlan(table, textMaxCh, plannedMaxCh);
    for (let col = 1; col <= 20; col += 1) {
      const varName = `--ui-list-col-${col}-max-ch`;
      const next = plannedMaxCh.get(col) ?? '';
      if (!shouldWriteValue(table.style.getPropertyValue(varName), next)) continue;
      if (next) table.style.setProperty(varName, next);
      else table.style.removeProperty(varName);
    }
  }
}

function recalcTableColumnPlan(table: HTMLTableElement, textMaxCh: number, plannedMaxCh: Map<number, string>) {
  const headerCells = Array.from(table.querySelectorAll('thead th'));
  const bodyRows = Array.from(table.querySelectorAll('tbody tr')).slice(0, 240) as HTMLTableRowElement[];
  // Ячейки и их нормализованный текст — по одному разу на строку. Прежде на каждую ячейку
  // приходился свой querySelectorAll('td,th'), и дважды: в проходе замера и в проходе подсказок.
  const rowCells: HTMLTableCellElement[][] = [];
  const rowTexts: string[][] = [];
  for (const row of bodyRows) {
    const cells = Array.from(row.cells);
    rowCells.push(cells);
    rowTexts.push(cells.map((cell) => normalizeText(cell.textContent ?? '')));
  }
  const colCount = Math.max(headerCells.length, ...rowCells.map((cells) => cells.length));
  if (colCount <= 0) return;

  for (let col = 0; col < colCount; col += 1) {
    // Колонка «№» (data-col-kind="rownum") сама схлопывается CSS; замер ей только вредит
    // (получила бы --ui-list-col-1-max-ch «имени» и title на каждой ячейке).
    if (headerCells[col]?.getAttribute('data-col-kind') === 'rownum') continue;
    const headerText = normalizeText(headerCells[col]?.textContent ?? '');
    const lengths: number[] = [];
    let numericVotes = 0;
    let textVotes = 0;
    let hasInteractiveContent = false;

    // Длина подписи в ширину НЕ идёт (владелец 08.09.2026): колонку меряют данные строк,
    // а заголовок обрезается в «…». Иначе «Дата поступления» раздувала колонку с датами
    // вдвое против самих дат. Голос за характер колонки заголовок при этом сохраняет —
    // по нему отличима числовая колонка, у которой все значения пусты.
    if (headerText) {
      if (isMostlyNumeric(headerText)) numericVotes += 1;
      else textVotes += 1;
    }

    for (let r = 0; r < rowCells.length; r += 1) {
      const cell = rowCells[r]?.[col];
      if (!cell) continue;
      // querySelector по ячейке дороже её текста, поэтому спрашиваем только пока интерактив
      // не найден и только у ячеек, внутри которых вообще есть элементы.
      if (!hasInteractiveContent && cell.firstElementChild) {
        hasInteractiveContent = cell.querySelector('button,input,select,textarea') !== null;
      }
      const text = rowTexts[r]?.[col] ?? '';
      if (!text) continue;
      lengths.push(text.length);
      if (isMostlyNumeric(text)) numericVotes += 1;
      else textVotes += 1;
    }

    if (lengths.length === 0) continue;
    const sorted = lengths.slice().sort((a, b) => a - b);
    // Quantile-based sizing keeps the majority width and ignores rare long outliers.
    const p65 = quantile(sorted, 0.65);
    const p80 = quantile(sorted, 0.8);
    const p90 = quantile(sorted, 0.9);
    const median = quantile(sorted, 0.5);
    const mostlyNumeric = numericVotes > textVotes;

    // Treat all textual columns as "name-like": prioritize readable width for typical text.
    let maxCh = clamp(Math.round(p65 * 0.2 + p80 * 0.55 + p90 * 0.25) + 3, 18, textMaxCh);
    if (mostlyNumeric) maxCh = clamp(Math.round(median + 2), 8, 16);
    if (hasInteractiveContent) maxCh = Math.max(maxCh, 22);

    plannedMaxCh.set(col + 1, String(maxCh));

    // Заголовок теперь всегда однострочный, поэтому подсказка на нём нужна не «иногда»,
    // а всегда, когда подпись длиннее колонки: иначе обрезанное имя нечем прочитать.
    const headerCell = headerCells[col] as HTMLElement | undefined;
    if (headerCell && headerText && headerText.length > maxCh && !headerCell.getAttribute('title')) {
      headerCell.setAttribute('title', headerText);
    }

    // Keep full value available in hover tooltip when visual truncation is applied.
    for (let r = 0; r < rowCells.length; r += 1) {
      const cell = rowCells[r]?.[col];
      const text = rowTexts[r]?.[col] ?? '';
      if (!cell || !text) continue;
      if (text.length > maxCh + 2 && !cell.getAttribute('title')) cell.setAttribute('title', text);
    }
  }
}

export function useAdaptiveListTables() {
  useEffect(() => {
    let timerId = 0;
    let lastScrollAt = 0;
    let observedScope: Element | null = null;

    // Содержимое слушаем только на активной панели: правка текста в чате или в поле ввода
    // не должна заказывать пересчёт таблиц. Плюс отбрасываем мутации вне таблиц списка.
    const contentObserver = new MutationObserver((records) => {
      if (!shouldRecalcListTables(records)) {
        perfTrace.count('adaptiveListTables.mutationsDropped');
        return;
      }
      schedule();
    });

    // data-pane-active — сигнал смены активной вкладки: без него пересчёт не запустился бы
    // (сам по себе показ панели не меняет ни childList, ни characterData). Ради него одного
    // держим наблюдателя на body, но уже без childList/characterData по всему документу.
    const paneObserver = new MutationObserver((records) => {
      const rescoped = attachContentObserver();
      if (!rescoped && !shouldRecalcListTables(records)) return;
      schedule();
    });

    /** Переподключает наблюдателя содержимого на активную панель; true — панель сменилась. */
    const attachContentObserver = (): boolean => {
      const pane = document.querySelector('.v3-tab-pane[data-pane-active="1"]');
      const scope = pane ?? document.body;
      // Закрытие активной вкладки не меняет ни одного атрибута: панель просто исчезает
      // вместе с наблюдателем на ней. Поэтому childList контейнера панелей — тоже сигнал,
      // и сигнал редкий: панели добавляются и убираются вкладками, а не прокруткой.
      const host = pane?.parentElement;
      if (host) paneObserver.observe(host, { childList: true });
      if (!scope || scope === observedScope) return false;
      contentObserver.disconnect();
      observedScope = scope;
      contentObserver.observe(scope, { subtree: true, childList: true, characterData: true });
      return true;
    };

    const run = () => {
      timerId = 0;
      if (shouldDeferScan(lastScrollAt, Date.now())) {
        // Прокрутка виртуального списка — непрерывный поток мутаций строк: пересчёт посреди
        // неё и дорог, и бесполезен, через кадр строки уже другие. Ждём тишины.
        perfTrace.count('adaptiveListTables.deferredByScroll');
        timerId = window.setTimeout(run, SCROLL_QUIET_MS);
        return;
      }
      attachContentObserver();
      perfTrace.measure('adaptiveListTables.recalc', recalcAdaptiveTableColumns);
    };

    // Trailing-задержка вместо rAF: при непрерывных мутациях rAF вырождался в пересчёт
    // каждый кадр, а здесь таймер перезапускается и пересчёт случается один раз в конце.
    const schedule = () => {
      perfTrace.count('adaptiveListTables.requested');
      if (timerId) window.clearTimeout(timerId);
      timerId = window.setTimeout(run, RECALC_DELAY_MS);
    };

    paneObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-pane-active'],
    });
    attachContentObserver();
    schedule();

    const onScroll = () => {
      lastScrollAt = Date.now();
    };
    // capture: scroll с внутреннего контейнера не всплывает до window.
    const scrollOptions: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('scroll', onScroll, scrollOptions);
    window.addEventListener('resize', schedule);
    const onModeChanged = () => schedule();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === LIST_COLUMNS_MODE_STORAGE_KEY) schedule();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(LIST_COLUMNS_MODE_CHANGED_EVENT, onModeChanged);

    return () => {
      if (timerId) window.clearTimeout(timerId);
      window.removeEventListener('scroll', onScroll, scrollOptions);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(LIST_COLUMNS_MODE_CHANGED_EVENT, onModeChanged);
      contentObserver.disconnect();
      paneObserver.disconnect();
    };
  }, []);
}

