import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { EmployeeListItem, TimesheetCodeDef, TimesheetData } from '@matricarmz/shared';
import { computeTimesheetRowTotals, isTimesheetWeekend, resolveEmploymentStatusCode, timesheetDayOfWeek, timesheetDaysInMonth } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const DOW = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const HOUR_CHIPS = [4, 6, 8, 9, 11, 12];
const FONT_MIN = 9;
const FONT_MAX = 22;
type ViewMode = 'full' | 'first' | 'second';

type Cell = { code: string | null; hours: number | null; comment: string | null };
type CellMap = Record<string, Record<number, Cell>>;
// Кисть: код-с-часами (ставится парой), код-без-часов (затирает ячейку), резинка (очищает).
type Brush =
  | { kind: 'worked'; code: string; hours: number | null }
  | { kind: 'absence'; code: string }
  | { kind: 'eraser' }
  | null;
type RectRef = { aRow: number; aDay: number; bRow: number; bDay: number };
type RectView = { minR: number; maxR: number; minD: number; maxD: number };

export function TimesheetGridPage(props: { timesheetId: string; canEdit: boolean; onBack: () => void }) {
  const { confirm } = useConfirm();
  const [ts, setTs] = useState<TimesheetData | null>(null);
  const [codes, setCodes] = useState<TimesheetCodeDef[]>([]);
  const [cells, setCells] = useState<CellMap>({});
  const [sel, setSel] = useState<{ rowId: string; day: number } | null>(null);
  const [brush, setBrush] = useState<Brush>(null);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [picker, setPicker] = useState(false);
  const [employees, setEmployees] = useState<EmployeeListItem[]>([]);
  const [empFilter, setEmpFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [pickerSel, setPickerSel] = useState<Set<string>>(new Set());
  const [rowSel, setRowSel] = useState<Set<string>>(new Set());
  const [workshopName, setWorkshopName] = useState('');
  const [commentEdit, setCommentEdit] = useState<{ rowId: string; day: number; name: string; text: string } | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const digitBuf = useRef<string>('');
  const painting = useRef(false);
  const lastHours = useRef<number>(8);
  const rectRef = useRef<RectRef | null>(null);
  const [rectView, setRectView] = useState<RectView | null>(null);
  const finishRef = useRef<(e: MouseEvent) => void>(() => {});
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [fontScale, setFontScale] = useState(14);
  const [autoFont, setAutoFont] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('full');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const appliedFont = autoFont ?? fontScale;
  // Право редактирования табеля: автор-создатель всегда; другие — только если автор включил
  // «Разрешить редактирование другим». Легаси-табели без автора (createdBy=null) — открыты.
  // props.canEdit — это разрешение (timesheet.edit); ниже накладываем авторский гейт.
  const editAllowed = ts ? (ts.isAuthor || ts.allowOthersEdit || !ts.createdBy) : false;
  const canEdit = props.canEdit && editAllowed;
  const setFont = (n: number) => { setFontScale(Math.min(FONT_MAX, Math.max(FONT_MIN, n))); setAutoFont(null); };
  const setMode = (m: ViewMode) => { setViewMode(m); setAutoFont(null); };

  const flash = (m: string, ms = 1600) => {
    setBusy(m);
    if (ms) setTimeout(() => setBusy(''), ms);
  };

  // Галку «разрешить редактирование другим» меняет только автор табеля (бэкенд это тоже гейтит).
  async function toggleAllowOthers(next: boolean) {
    if (!ts || !ts.isAuthor) return;
    const r = await window.matrica.timesheets.update({ id: ts.id, allowOthersEdit: next });
    if (!r.ok) { flash(`Ошибка: ${r.error}`, 3000); return; }
    setTs((prev) => (prev ? { ...prev, allowOthersEdit: next } : prev));
  }

  const reload = useCallback(async () => {
    const [t, c, w] = await Promise.all([window.matrica.timesheets.get(props.timesheetId), window.matrica.timesheets.codes(), window.matrica.workshops.list()]);
    if (c.ok) setCodes(c.codes);
    if (t.ok) {
      setTs(t.timesheet);
      if (w.ok) setWorkshopName(w.rows.find((r) => r.id === t.timesheet.workshopId)?.name ?? '');
      const map: CellMap = {};
      for (const row of t.timesheet.rows) {
        const rm: Record<number, Cell> = {};
        for (const cell of row.cells) rm[cell.day] = { code: cell.code, hours: cell.hours, comment: cell.comment ?? null };
        map[row.id] = rm;
      }
      setCells(map);
    } else {
      flash(`Ошибка загрузки: ${t.error}`, 0);
    }
    setLoading(false);
  }, [props.timesheetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Глобальный mouseup: ЛКМ — стоп freehand-кисти; ПКМ — финал прямоугольника (заливка/комментарий).
  // Делегируем в finishRef (переустанавливается каждый рендер) — чтобы видеть свежие brush/ts/cells.
  useEffect(() => {
    const up = (e: MouseEvent) => finishRef.current(e);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const days = useMemo(() => (ts ? timesheetDaysInMonth(ts.year, ts.month) : 0), [ts]);
  const dayList = useMemo(() => Array.from({ length: days }, (_, i) => i + 1), [days]);
  const displayDays = useMemo(() => {
    if (viewMode === 'first') return dayList.filter((d) => d <= 15);
    if (viewMode === 'second') return dayList.filter((d) => d >= 16);
    return dayList;
  }, [dayList, viewMode]);
  const codeByCode = useMemo(() => new Map(codes.map((c) => [c.code, c])), [codes]);

  // Авто-fit по ширине: если табель не влезает в окно — уменьшаем шрифт (монотонно, до FONT_MIN),
  // и если на минимуме «месяц целиком» всё равно не влезает — переключаемся на половину месяца.
  useEffect(() => {
    const measure = () => {
      const sc = scrollRef.current;
      const tb = tableRef.current;
      if (!sc || !tb) return;
      const avail = sc.clientWidth;
      const natural = tb.scrollWidth;
      const applied = autoFont ?? fontScale;
      if (natural > avail + 2) {
        const target = Math.max(FONT_MIN, Math.floor((applied * avail) / natural));
        if (target < applied) { setAutoFont(target); return; }
        if (viewMode === 'full') setViewMode('first');
      }
    };
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure); };
  }, [viewMode, fontScale, autoFont, days, displayDays.length, ts?.rows.length]);

  function getCell(rowId: string, day: number): Cell {
    return cells[rowId]?.[day] ?? { code: null, hours: null, comment: null };
  }

  async function persist(rowId: string, day: number, next: Cell) {
    setCells((prev) => ({ ...prev, [rowId]: { ...(prev[rowId] ?? {}), [day]: next } }));
    if (!canEdit) return;
    const r = await window.matrica.timesheets.setCells({ rowId, cells: [{ day, code: next.code, hours: next.hours, comment: next.comment }] });
    if (!r.ok) flash(`Ошибка: ${r.error}`, 3000);
  }

  function applyCode(rowId: string, day: number, code: string) {
    const def = codeByCode.get(code);
    const cur = getCell(rowId, day);
    // Код-без-часов (не «отработанный») затирает часы — остаётся только код.
    if (def && !def.countsAsWorked) { void persist(rowId, day, { code, hours: null, comment: cur.comment }); return; }
    const hours = cur.hours != null ? cur.hours : def?.defaultHours ?? null;
    void persist(rowId, day, { code, hours, comment: cur.comment });
  }
  function applyHours(rowId: string, day: number, hours: number) {
    const cur = getCell(rowId, day);
    void persist(rowId, day, { code: cur.code ?? 'Я', hours, comment: cur.comment });
  }
  function clearCell(rowId: string, day: number) {
    const cur = getCell(rowId, day);
    void persist(rowId, day, { code: null, hours: null, comment: cur.comment });
  }
  function setComment(rowId: string, day: number, comment: string) {
    const cur = getCell(rowId, day);
    void persist(rowId, day, { code: cur.code, hours: cur.hours, comment: comment.trim() ? comment.trim() : null });
  }
  function openComment(rowId: string, day: number) {
    if (!canEdit) return;
    const name = ts?.rows.find((r) => r.id === rowId)?.fullName ?? '';
    setCommentEdit({ rowId, day, name, text: getCell(rowId, day).comment ?? '' });
  }

  // Следующее состояние ячейки по активной кисти (общий хелпер для клика, freehand и прямоугольника).
  function nextCellForBrush(cur: Cell): Cell | null {
    if (!brush) return null;
    if (brush.kind === 'eraser') return { code: null, hours: null, comment: cur.comment };
    if (brush.kind === 'absence') return { code: brush.code, hours: null, comment: cur.comment };
    return { code: brush.code, hours: brush.hours, comment: cur.comment }; // worked: код+часы парой
  }
  // Применить активную кисть к ячейке. Без кисти — ничего не делает.
  function paintAt(rowId: string, day: number) {
    if (!brush || !canEdit) return;
    const next = nextCellForBrush(getCell(rowId, day));
    if (next) void persist(rowId, day, next);
  }
  // Заливка прямоугольника активной кистью: один setCells на строку (пакетно, не N IPC на ячейку).
  async function fillRect(r: RectRef) {
    if (!ts || !brush || !canEdit) return;
    const minR = Math.min(r.aRow, r.bRow), maxR = Math.max(r.aRow, r.bRow);
    const minD = Math.min(r.aDay, r.bDay), maxD = Math.max(r.aDay, r.bDay);
    const daysInRange = displayDays.filter((d) => d >= minD && d <= maxD);
    const rowsInRange = ts.rows.slice(minR, maxR + 1);
    if (!daysInRange.length || !rowsInRange.length) return;
    const perRow = rowsInRange.map((row) => ({
      row,
      next: daysInRange.map((d) => ({ day: d, cell: nextCellForBrush(getCell(row.id, d)) as Cell })),
    }));
    setCells((prev) => {
      const copy = { ...prev };
      for (const { row, next } of perRow) {
        const rm = { ...(copy[row.id] ?? {}) };
        for (const { day, cell } of next) rm[day] = cell;
        copy[row.id] = rm;
      }
      return copy;
    });
    for (const { row, next } of perRow) {
      const res = await window.matrica.timesheets.setCells({ rowId: row.id, cells: next.map(({ day, cell }) => ({ day, code: cell.code, hours: cell.hours, comment: cell.comment })) });
      if (!res.ok) { flash(`Ошибка: ${res.error}`, 3000); return; }
    }
  }
  // ЛКМ — выбор ячейки + freehand-кисть; ПКМ — старт прямоугольника (якорь).
  function onCellMouseDown(rowIdx: number, rowId: string, day: number, e: React.MouseEvent) {
    if (e.button === 2) {
      e.preventDefault();
      rectRef.current = { aRow: rowIdx, aDay: day, bRow: rowIdx, bDay: day };
      setRectView({ minR: rowIdx, maxR: rowIdx, minD: day, maxD: day });
      return;
    }
    if (e.button !== 0) return;
    digitBuf.current = '';
    setSel({ rowId, day });
    gridRef.current?.focus();
    if (brush && canEdit) {
      painting.current = true;
      paintAt(rowId, day);
      e.preventDefault(); // не выделять текст при протяжке
    }
  }
  // Заход курсора в ячейку: зажата ЛКМ → freehand; зажата ПКМ → растим прямоугольник.
  function onCellMouseEnter(rowIdx: number, rowId: string, day: number, e: React.MouseEvent) {
    if (painting.current) { paintAt(rowId, day); return; }
    if (rectRef.current && (e.buttons & 2) !== 0) {
      const a = rectRef.current;
      rectRef.current = { ...a, bRow: rowIdx, bDay: day };
      setRectView({ minR: Math.min(a.aRow, rowIdx), maxR: Math.max(a.aRow, rowIdx), minD: Math.min(a.aDay, day), maxD: Math.max(a.aDay, day) });
    }
  }

  function moveSel(dRow: number, dDay: number) {
    if (!ts || !sel) return;
    const rowIdx = ts.rows.findIndex((r) => r.id === sel.rowId);
    if (rowIdx < 0) return;
    let nextRow = rowIdx + dRow;
    let nextDay = sel.day + dDay;
    if (nextDay < 1) nextDay = 1;
    if (nextDay > days) nextDay = days;
    if (nextRow < 0) nextRow = 0;
    if (nextRow > ts.rows.length - 1) nextRow = ts.rows.length - 1;
    const row = ts.rows[nextRow];
    if (row) setSel({ rowId: row.id, day: nextDay });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Пока открыта модалка (комментарий/пикер) или фокус в поле ввода — не перехватывать клавиши:
    // иначе глобальные грид-хоткеи (буква→код, цифра→часы, стрелки) глотают ввод в <textarea>/<input>.
    if (commentEdit || picker) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (!sel || !canEdit) return;
    const { rowId, day } = sel;
    if (e.key === 'ArrowLeft') { digitBuf.current = ''; moveSel(0, -1); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { digitBuf.current = ''; moveSel(0, 1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { digitBuf.current = ''; moveSel(-1, 0); e.preventDefault(); return; }
    if (e.key === 'ArrowDown' || e.key === 'Enter') { digitBuf.current = ''; moveSel(1, 0); e.preventDefault(); return; }
    if (e.key === 'Tab') { digitBuf.current = ''; moveSel(0, e.shiftKey ? -1 : 1); e.preventDefault(); return; }
    if (e.key === 'Escape') { digitBuf.current = ''; setSel(null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { digitBuf.current = ''; clearCell(rowId, day); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'в')) {
      const rowIdx = ts?.rows.findIndex((r) => r.id === rowId) ?? -1;
      const above = rowIdx > 0 ? ts?.rows[rowIdx - 1] : null;
      if (above) {
        const src = getCell(above.id, day);
        const cur = getCell(rowId, day);
        void persist(rowId, day, { code: src.code, hours: src.hours, comment: cur.comment });
      }
      e.preventDefault();
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      digitBuf.current = (digitBuf.current + e.key).slice(-2);
      let h = Number(digitBuf.current);
      if (h > 24) { h = Number(e.key); digitBuf.current = e.key; }
      applyHours(rowId, day, h);
      e.preventDefault();
      return;
    }
    if (e.key.length === 1 && /\p{L}/u.test(e.key)) {
      digitBuf.current = '';
      const k = e.key.toUpperCase();
      const exact = codes.find((c) => c.code.toUpperCase() === k);
      const prefix = codes.filter((c) => c.code.toUpperCase().startsWith(k));
      const pick = exact ?? (prefix.length === 1 ? prefix[0] : undefined);
      if (pick) applyCode(rowId, day, pick.code);
      e.preventDefault();
    }
  }

  async function addEmployees(emps: EmployeeListItem[]) {
    if (!emps.length) return;
    setBusy(`Добавление (${emps.length})…`);
    const r = await window.matrica.timesheets.addRows({
      timesheetId: props.timesheetId,
      employees: emps.map((emp) => ({ employeeId: emp.id, ...(emp.position ? { position: emp.position } : {}) })),
    });
    if (!r.ok) { flash(`Ошибка: ${r.error}`, 3000); return; }
    setPickerSel(new Set());
    await reload();
    flash(`Добавлено: ${r.added}`);
  }

  async function removeRow(rowId: string, name: string) {
    const ok = await confirm({ detail: `Убрать сотрудника «${name}» из табеля?` });
    if (!ok) return;
    const r = await window.matrica.timesheets.removeRow(rowId);
    if (!r.ok) { flash(`Ошибка: ${r.error}`, 3000); return; }
    setRowSel((prev) => { const n = new Set(prev); n.delete(rowId); return n; });
    await reload();
  }

  async function removeSelectedRows() {
    if (!ts) return;
    const ids = ts.rows.filter((r) => rowSel.has(r.id)).map((r) => r.id);
    if (!ids.length) return;
    const ok = await confirm({ detail: `Убрать выбранных сотрудников (${ids.length}) из табеля?` });
    if (!ok) return;
    setBusy(`Удаление (${ids.length})…`);
    for (const id of ids) {
      const r = await window.matrica.timesheets.removeRow(id);
      if (!r.ok) { flash(`Ошибка: ${r.error}`, 3000); return; }
    }
    setRowSel(new Set());
    await reload();
    flash(`Убрано: ${ids.length}`);
  }

  async function openPicker() {
    setPicker(true);
    setPickerSel(new Set());
    setEmpFilter('');
    setDeptFilter('');
    if (employees.length === 0) {
      const list = await window.matrica.employees.list();
      setEmployees(Array.isArray(list) ? list : []);
    }
  }

  if (loading) return <div style={{ padding: 16, color: '#64748b' }}>Загрузка табеля…</div>;
  if (!ts) return <div style={{ padding: 16, color: '#b91c1c' }}>{busy || 'Табель не найден'}</div>;

  const presentRows = ts.rows;
  const empName = (e: EmployeeListItem) => e.fullName || e.displayName || `${e.lastName ?? ''} ${e.firstName ?? ''}`.trim() || e.id;
  // В табель добавляем только работающих — уволенных (по статусу или дате увольнения) в пикер не показываем.
  const availableEmps = employees
    .filter((e) => resolveEmploymentStatusCode(e.employmentStatus ?? null, e.terminationDate ?? null) === 'working')
    .filter((e) => !presentRows.some((r) => r.employeeId === e.id));
  // Подразделения, доступные для добавления (employees связаны с Подразделением, не с цехом —
  // прямой связи employee→workshop в схеме нет, поэтому групповое добавление идёт по подразделению).
  const departments = Array.from(new Set(availableEmps.map((e) => e.departmentName).filter((d): d is string => !!d))).sort((a, b) => a.localeCompare(b, 'ru'));
  const filteredEmps = availableEmps
    .filter((e) => !deptFilter || e.departmentName === deptFilter)
    .filter((e) => empName(e).toLowerCase().includes(empFilter.toLowerCase()));
  const allShownSelected = filteredEmps.length > 0 && filteredEmps.every((e) => pickerSel.has(e.id));
  // «Добавить весь цех» — работающие сотрудники, привязанные к цеху ЭТОГО табеля (workshop_id у
  // сотрудника, заполняется на карточке). Видна только для цех-scoped табеля (ts.workshopId задан).
  const workshopEmps = ts.workshopId ? availableEmps.filter((e) => e.workshopId === ts.workshopId) : [];

  // column totals (по отображаемым дням)
  const colTotals = displayDays.map((d) => {
    let hours = 0;
    let present = 0;
    for (const row of presentRows) {
      const c = getCell(row.id, d);
      const def = c.code ? codeByCode.get(c.code) : null;
      const worked = def ? def.countsAsWorked : (c.hours ?? 0) > 0;
      if (worked && (c.hours ?? 0) > 0) { hours += c.hours ?? 0; present += 1; }
    }
    return { hours, present };
  });
  const grandHours = colTotals.reduce((s, c) => s + c.hours, 0);
  const totalNorm = ts.normHours != null ? Math.round(ts.normHours * Math.max(1, presentRows.length) * 100) / 100 : null;

  // Блоки кодов: с часами (countsAsWorked) и без часов.
  const workedCodes = codes.filter((c) => c.countsAsWorked);
  const absenceCodes = codes.filter((c) => !c.countsAsWorked);
  // Шрифты ячейки (R10): код-с-часами — код мелко сверху, часы 2× жирные чёрные снизу; код-без-часов — крупно.
  const codeFont = Math.max(8, Math.round(appliedFont * 0.72));
  const hoursFont = codeFont * 2;
  const bigCodeFont = Math.round(appliedFont * 1.25);

  // Финал ПКМ-жеста (через finishRef, чтобы видеть свежие brush/ts): same-cell → комментарий, иначе → заливка.
  finishRef.current = (e: MouseEvent) => {
    if (e.button === 0) { painting.current = false; return; }
    if (e.button !== 2) return;
    const r = rectRef.current;
    rectRef.current = null;
    setRectView(null);
    if (!r) return;
    if (r.aRow === r.bRow && r.aDay === r.bDay) {
      const row = presentRows[r.aRow];
      if (row) openComment(row.id, r.aDay);
    } else {
      void fillRect(r);
    }
  };

  const sheet = ts;
  // Рендер ячейки для печати (R10): код-без-часов крупно; код-с-часами — код мелко сверху, часы крупно-жирно снизу.
  const printCellText = (c: Cell) => {
    const code = c.code ?? '';
    const h = c.hours != null ? String(c.hours) : '';
    if (code && h) return `<div style="font-size:8px;line-height:1.1">${escapeHtml(code)}</div><div style="font-size:15px;font-weight:800;color:#000;line-height:1.1">${escapeHtml(h)}</div>`;
    if (code) return `<div style="font-size:14px;font-weight:700">${escapeHtml(code)}</div>`;
    if (h) return `<div style="font-size:15px;font-weight:800;color:#000">${escapeHtml(h)}</div>`;
    return '';
  };
  const gridHtml = (fromDay: number, toDay: number) => {
    const cols = dayList.filter((d) => d >= fromDay && d <= toDay);
    const head = `<tr><th>№</th><th style="text-align:left">ФИО</th>${cols
      .map((d) => `<th${isTimesheetWeekend(sheet.year, sheet.month, d, sheet.weekMode) ? ' style="background:#eef2ff"' : ''}>${d}<br/><span style="font-weight:400;font-size:9px">${DOW[timesheetDayOfWeek(sheet.year, sheet.month, d)]}</span></th>`)
      .join('')}<th>Σч</th><th>дн.</th></tr>`;
    const body = presentRows
      .map((row, i) => {
        const rc = cols.map((d) => ({ day: d, ...getCell(row.id, d) }));
        const tot = computeTimesheetRowTotals(rc, codes);
        const dayTds = cols
          .map((d) => {
            const c = getCell(row.id, d);
            const we = isTimesheetWeekend(sheet.year, sheet.month, d, sheet.weekMode);
            return `<td style="text-align:center${we ? ';background:#f1f5f9' : ''}">${printCellText(c)}</td>`;
          })
          .join('');
        const fio = `${escapeHtml(row.fullName || '')}${row.position ? `<div style="font-size:8px;color:#64748b;font-weight:400">${escapeHtml(row.position)}</div>` : ''}`;
        return `<tr><td style="text-align:center">${i + 1}</td><td style="text-align:left;white-space:nowrap">${fio}</td>${dayTds}<td style="text-align:center;font-weight:700">${tot.totalHours || ''}</td><td style="text-align:center">${tot.workedDays || ''}</td></tr>`;
      })
      .join('');
    // ширина: узкие колонки дней (G68 — table-layout:auto раздувает; width:1%+nowrap держит компактно)
    return `<table style="font-size:11px;table-layout:auto;width:100%">${head}${body}</table>`;
  };
  const legendHtml = () => `<div style="font-size:11px;color:#334155;line-height:1.6">${codes.map((c) => `<b>${escapeHtml(c.code)}</b> — ${escapeHtml(c.title)}`).join(' · ')}</div>`;
  const decodeHtml = () => {
    const blocks = presentRows
      .map((row) => {
        const items = dayList.map((d) => ({ d, comment: getCell(row.id, d).comment })).filter((x) => x.comment);
        if (!items.length) return '';
        return `<div style="margin-bottom:10px"><b>${escapeHtml(row.fullName || '')}</b><ul>${items.map((x) => `<li>${x.d} ${MONTHS[sheet.month - 1]} — ${escapeHtml(String(x.comment))}</li>`).join('')}</ul></div>`;
      })
      .filter(Boolean)
      .join('');
    return blocks || '<div class="muted">Комментариев нет.</div>';
  };
  const doPrint = () => {
    // Порядок печати (A6): табель → легенда (по влезаемости) → расшифровки на отдельном листе.
    // Легенда — отдельная секция с break-inside:avoid: не рвётся, и оператор может снять галку,
    // если не влезает. Расшифровки начинаются с новой страницы (page-break-before).
    openPrintPreview({
      title: `Табель учёта рабочего времени${workshopName ? ` · ${workshopName}` : ''}`,
      subtitle: `${MONTHS[sheet.month - 1]} ${sheet.year} · ${sheet.weekMode}-дневка`,
      sections: [
        { id: 'full', title: 'Месяц целиком', html: gridHtml(1, days), checked: true },
        { id: 'first', title: 'Первая половина месяца (1–15)', html: gridHtml(1, 15), checked: false },
        { id: 'second', title: `Вторая половина месяца (16–${days})`, html: gridHtml(16, days), checked: false },
        { id: 'legend', title: 'Легенда кодов', html: legendHtml(), checked: true },
        { id: 'decode', title: 'Расшифровки по работникам (на отдельном листе)', html: `<div style="page-break-before:always">${decodeHtml()}</div>`, checked: false },
      ],
    });
  };

  return (
    <div style={{ padding: 4 }} ref={gridRef} tabIndex={0} onKeyDown={onKeyDown}>
      {/* Панель управления табелем (тулбар + кисти-коды) закреплена сверху: при вертикальной
          прокрутке длинного табеля внутри .ui-content-viewport она не уезжает (sticky top:0,
          непрозрачный фон перекрывает строки, что прокручиваются под ней). */}
      <div style={{ position: 'sticky', top: 0, zIndex: 20, background: '#fff', paddingTop: 4, marginTop: -4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <Button variant="ghost" onClick={props.onBack}>← К списку</Button>
        <strong style={{ fontSize: 16 }}>Табель · {MONTHS[ts.month - 1]} {ts.year}</strong>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          {ts.weekMode}-дневка · норма {ts.normHours ?? '—'} ч/чел · отработано {grandHours} из {totalNorm ?? '—'} ч {totalNorm != null ? (grandHours >= totalNorm ? '✓' : `(−${Math.round((totalNorm - grandHours) * 100) / 100})`) : ''}
        </span>
        <div style={{ display: 'flex', gap: 0, alignItems: 'center', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden' }}>
          <button onClick={() => setMode('first')} style={segBtn(viewMode === 'first')} title="Первая половина месяца">1–15</button>
          <button onClick={() => setMode('second')} style={segBtn(viewMode === 'second')} title="Вторая половина месяца">16–{days}</button>
          <button onClick={() => setMode('full')} style={segBtn(viewMode === 'full')} title="Месяц целиком">Месяц</button>
        </div>
        <div style={{ display: 'flex', gap: 2, alignItems: 'center' }} title="Размер шрифта табеля">
          <button onClick={() => setFont(appliedFont - 1)} disabled={appliedFont <= FONT_MIN} style={fontBtn}>A−</button>
          <span style={{ fontSize: 11, color: '#64748b', minWidth: 16, textAlign: 'center' }}>{appliedFont}</span>
          <button onClick={() => setFont(appliedFont + 1)} disabled={appliedFont >= FONT_MAX} style={fontBtn}>A+</button>
        </div>
        <span style={{ flex: 1 }} />
        <label
          title={ts.isAuthor ? 'Разрешить другим пользователям редактировать этот табель (по умолчанию — только автор)' : 'Менять это разрешение может только автор табеля'}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#475569', cursor: ts.isAuthor ? 'pointer' : 'default', opacity: ts.isAuthor ? 1 : 0.65 }}
        >
          <input type="checkbox" checked={ts.allowOthersEdit} disabled={!ts.isAuthor} onChange={(e) => void toggleAllowOthers(e.target.checked)} />
          Разрешить редактирование другим
        </label>
        {props.canEdit && !canEdit && (
          <span title="Автор не разрешил другим редактировать этот табель" style={{ fontSize: 12, color: '#b45309', fontWeight: 600 }}>🔒 только автор</span>
        )}
        {busy && <span style={{ fontSize: 12, color: busy.startsWith('Ошибка') ? '#b91c1c' : '#64748b' }}>{busy}</span>}
        {canEdit && <Button variant="ghost" onClick={() => void openPicker()}>+ Сотрудники</Button>}
        {canEdit && rowSel.size > 0 && <Button variant="ghost" title="Убрать отмеченных сотрудников из табеля" onClick={() => void removeSelectedRows()}>🗑 Убрать отмеченных ({rowSel.size})</Button>}
        {canEdit && <Button variant="ghost" disabled={!sel} title="Комментарий к выбранной ячейке (где был / что делал)" onClick={() => sel && openComment(sel.rowId, sel.day)}>💬 Комментарий</Button>}
        <Button variant="ghost" onClick={doPrint}>Печать</Button>
      </div>

      {canEdit && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', padding: 8, border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 8, background: '#f8fafc' }}>
          <span style={{ fontSize: 12, color: '#64748b', marginRight: 4 }}>Коды (с часами):</span>
          {workedCodes.map((c) => (
            <button
              key={c.code}
              title={c.title}
              onClick={() => setBrush((b) => (b?.kind === 'worked' && b.code === c.code ? null : { kind: 'worked', code: c.code, hours: c.defaultHours ?? lastHours.current }))}
              style={chipStyle(c.color, brush?.kind === 'worked' && brush.code === c.code)}
            >
              {c.code}
            </button>
          ))}
          <span style={{ width: 1, height: 22, background: '#cbd5e1', margin: '0 4px' }} />
          <span style={{ fontSize: 12, color: '#64748b', marginRight: 4 }}>Часы:</span>
          {HOUR_CHIPS.map((h) => (
            <button
              key={h}
              title="Часы к коду (ставятся в паре)"
              onClick={() => { lastHours.current = h; setBrush((b) => (b && b.kind === 'worked' ? { ...b, hours: h } : { kind: 'worked', code: 'Я', hours: h })); }}
              style={chipStyle('#e0f2fe', brush?.kind === 'worked' && brush.hours === h)}
            >
              {h}
            </button>
          ))}
          <span style={{ width: 1, height: 22, background: '#cbd5e1', margin: '0 4px' }} />
          <span style={{ fontSize: 12, color: '#64748b', marginRight: 4 }}>Коды (без часов):</span>
          {absenceCodes.map((c) => (
            <button
              key={c.code}
              title={c.title}
              onClick={() => setBrush((b) => (b?.kind === 'absence' && b.code === c.code ? null : { kind: 'absence', code: c.code }))}
              style={chipStyle(c.color, brush?.kind === 'absence' && brush.code === c.code)}
            >
              {c.code}
            </button>
          ))}
          <span style={{ width: 1, height: 22, background: '#cbd5e1', margin: '0 4px' }} />
          <button onClick={() => setBrush((b) => (b?.kind === 'eraser' ? null : { kind: 'eraser' }))} style={chipStyle(brush?.kind === 'eraser' ? '#fecaca' : '#fff', brush?.kind === 'eraser')} title="Резинка — очистить ячейки от кодов">⌫ Резинка</button>
          <button onClick={() => setBrush(null)} style={chipStyle(brush ? '#fff' : '#dcfce7', false)} title="Снять кисть">
            {brush ? `${brushLabel(brush)} — снять` : 'Кисть выкл'}
          </button>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>Выбери код+часы / код без часов / резинку — это «кисть»; ЛКМ-клик или протяжка ставит её. ПКМ-протяжка — прямоугольная заливка; ПКМ-клик без движения — комментарий. Клавиши: цифры → часы, буква → код, ←↑↓→/Enter/Tab — навигация, Del — очистить, Ctrl+D — повтор сверху.</span>
        </div>
      )}
      </div>

      <div
        ref={scrollRef}
        style={{ overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 10 }}
        onMouseMove={(e) => { if (brush) setCursorPos({ x: e.clientX, y: e.clientY }); }}
        onMouseLeave={() => setCursorPos(null)}
      >
        <table ref={tableRef} style={{ borderCollapse: 'collapse', fontSize: appliedFont, width: '100%', tableLayout: 'auto' }}>
          <thead>
            <tr style={{ background: '#0f2f72', color: '#fff' }}>
              <th style={{ ...hCell, position: 'sticky', left: 0, zIndex: 2, background: '#0f2f72', width: 30 }}>№</th>
              <th style={{ ...hCell, position: 'sticky', left: 30, zIndex: 2, background: '#0f2f72', width: 160, minWidth: 120, textAlign: 'left' }}>ФИО</th>
              {displayDays.map((d) => {
                const we = isTimesheetWeekend(ts.year, ts.month, d, ts.weekMode);
                return (
                  <th key={d} style={{ ...hCell, background: we ? '#1e3a8a' : '#0f2f72' }}>
                    <div>{d}</div>
                    <div style={{ fontSize: Math.max(8, appliedFont - 4), opacity: 0.8 }}>{DOW[timesheetDayOfWeek(ts.year, ts.month, d)]}</div>
                  </th>
                );
              })}
              <th style={{ ...hCell, minWidth: 44 }}>Σч</th>
              <th style={{ ...hCell, minWidth: 36 }}>дн.</th>
              {canEdit && (
                <th style={{ ...hCell, minWidth: 30 }}>
                  <input
                    type="checkbox"
                    title="Отметить всех / снять отметку"
                    checked={presentRows.length > 0 && presentRows.every((r) => rowSel.has(r.id))}
                    onChange={(e) => setRowSel(e.target.checked ? new Set(presentRows.map((r) => r.id)) : new Set())}
                  />
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {presentRows.map((row, idx) => {
              const rowCells = dayList.map((d) => ({ day: d, ...getCell(row.id, d) }));
              const totals = computeTimesheetRowTotals(rowCells, codes);
              return (
                <tr key={row.id}>
                  <td style={{ ...bCell, position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>{idx + 1}</td>
                  <td style={{ ...bCell, position: 'sticky', left: 30, background: '#fff', zIndex: 1, textAlign: 'left', whiteSpace: 'nowrap' }}>
                    {row.fullName || '(без имени)'}
                    {row.position ? <div style={{ fontSize: 10, color: '#94a3b8' }}>{row.position}</div> : null}
                  </td>
                  {displayDays.map((d) => {
                    const c = getCell(row.id, d);
                    const we = isTimesheetWeekend(ts.year, ts.month, d, ts.weekMode);
                    const isSel = sel?.rowId === row.id && sel.day === d;
                    const def = c.code ? codeByCode.get(c.code) : null;
                    const inRect = !!rectView && idx >= rectView.minR && idx <= rectView.maxR && d >= rectView.minD && d <= rectView.maxD;
                    return (
                      <td
                        key={d}
                        onMouseDown={(e) => canEdit && onCellMouseDown(idx, row.id, d, e)}
                        onMouseEnter={(e) => canEdit && onCellMouseEnter(idx, row.id, d, e)}
                        onContextMenu={(e) => e.preventDefault()}
                        onDoubleClick={() => openComment(row.id, d)}
                        title={c.comment ? String(c.comment) : undefined}
                        style={{
                          ...bCell,
                          position: 'relative',
                          cursor: canEdit ? (brush ? 'crosshair' : 'pointer') : 'default',
                          userSelect: 'none',
                          background: inRect ? '#fde68a' : isSel ? '#bfdbfe' : def?.color ?? (we ? '#f1f5f9' : '#fff'),
                          outline: inRect ? '2px solid #d97706' : isSel ? '2px solid #2563eb' : 'none',
                          padding: 0,
                          minHeight: 30,
                        }}
                      >
                        {c.code && c.hours != null ? (
                          <>
                            <div style={{ fontWeight: 400, lineHeight: 1, fontSize: codeFont, color: '#475569' }}>{c.code}</div>
                            <div style={{ fontWeight: 800, lineHeight: 1, fontSize: hoursFont, color: '#000' }}>{c.hours}</div>
                          </>
                        ) : c.code ? (
                          <div style={{ fontWeight: 700, lineHeight: 1.05, fontSize: bigCodeFont, color: '#0b1220' }}>{c.code}</div>
                        ) : c.hours != null ? (
                          <div style={{ fontWeight: 800, lineHeight: 1, fontSize: hoursFont, color: '#000' }}>{c.hours}</div>
                        ) : null}
                        {c.comment ? <div title={String(c.comment)} style={{ position: 'absolute', top: 0, right: 0, width: 0, height: 0, borderTop: '12px solid #7f1d1d', borderLeft: '12px solid transparent' }} /> : null}
                      </td>
                    );
                  })}
                  <td style={{ ...bCell, fontWeight: 700 }}>{totals.totalHours || ''}</td>
                  <td style={bCell}>{totals.workedDays || ''}</td>
                  {canEdit && (
                    <td style={bCell}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                        <input
                          type="checkbox"
                          title="Отметить для группового удаления"
                          checked={rowSel.has(row.id)}
                          onChange={() => setRowSel((prev) => { const n = new Set(prev); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; })}
                        />
                        <button onClick={() => void removeRow(row.id, row.fullName)} title="Убрать из табеля" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#b91c1c', fontWeight: 700 }}>×</button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {presentRows.length === 0 && (
              <tr>
                <td colSpan={displayDays.length + 4} style={{ padding: 14, color: '#6b7280' }}>
                  Нет сотрудников. {canEdit ? 'Нажмите «+ Сотрудники».' : ''}
                </td>
              </tr>
            )}
          </tbody>
          {presentRows.length > 0 && (
            <tfoot>
              <tr style={{ background: '#f1f5f9', fontWeight: 700 }}>
                <td style={{ ...bCell, position: 'sticky', left: 0, background: '#f1f5f9' }} />
                <td style={{ ...bCell, position: 'sticky', left: 30, background: '#f1f5f9', textAlign: 'right' }}>Явилось / часов:</td>
                {colTotals.map((c, i) => (
                  <td key={i} style={{ ...bCell, fontSize: 9 }}>
                    <div>{c.present || ''}</div>
                    <div style={{ color: '#475569' }}>{c.hours || ''}</div>
                  </td>
                ))}
                <td style={bCell}>{grandHours || ''}</td>
                <td style={bCell} />
                {canEdit && <td style={bCell} />}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {codes.length > 0 && (
        <div style={{ marginTop: 8, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 10, background: '#f8fafc', fontSize: 11, color: '#334155', lineHeight: 1.7 }}>
          <span style={{ color: '#64748b', marginRight: 6 }}>Легенда:</span>
          {codes.map((c, i) => (
            <span key={c.code}>
              {i > 0 ? ' · ' : ''}<b>{c.code}</b> — {c.title}
            </span>
          ))}
        </div>
      )}

      {brush && cursorPos && (
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: cursorPos.x + 14,
            top: cursorPos.y + 14,
            pointerEvents: 'none',
            zIndex: 1500,
            minWidth: 22,
            padding: '2px 7px',
            borderRadius: 6,
            border: '2px solid #2563eb',
            background: brush.kind === 'eraser' ? '#fecaca' : codeByCode.get(brush.code)?.color ?? '#fff',
            color: '#0b1220',
            fontWeight: 700,
            fontSize: 12,
            boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
          }}
        >
          {brushLabel(brush)}
        </div>
      )}

      {picker && (
        <div onClick={() => setPicker(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 16, width: 460, maxHeight: '80vh', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>Добавить сотрудников</strong>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" onClick={() => setPicker(false)}>Закрыть</Button>
            </div>
            {ts.workshopId && (
              <Button
                variant="primary"
                disabled={!workshopEmps.length}
                onClick={() => void addEmployees(workshopEmps)}
              >
                Добавить весь цех{workshopName ? ` «${workshopName}»` : ''} ({workshopEmps.length})
              </Button>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} title="Фильтр по подразделению" style={{ flex: 1, height: 32, padding: '4px 8px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff' }}>
                <option value="">Все подразделения</option>
                {departments.map((d) => (<option key={d} value={d}>{d}</option>))}
              </select>
              <input autoFocus placeholder="Поиск по ФИО…" value={empFilter} onChange={(e) => setEmpFilter(e.target.value)} style={{ flex: 1, height: 32, padding: '4px 8px', borderRadius: 8, border: '1px solid #d1d5db' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569', cursor: filteredEmps.length ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                disabled={filteredEmps.length === 0}
                checked={allShownSelected}
                onChange={() => setPickerSel((prev) => {
                  const n = new Set(prev);
                  if (allShownSelected) filteredEmps.forEach((e) => n.delete(e.id));
                  else filteredEmps.forEach((e) => n.add(e.id));
                  return n;
                })}
              />
              Выбрать всех показанных ({filteredEmps.length})
            </label>
            <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              {filteredEmps.slice(0, 500).map((e) => {
                const checked = pickerSel.has(e.id);
                return (
                  <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, background: checked ? '#eff6ff' : '#fff', cursor: 'pointer' }}>
                    <input type="checkbox" checked={checked} onChange={() => setPickerSel((prev) => { const n = new Set(prev); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} />
                    <span style={{ flex: 1 }}>{empName(e)}{e.position ? <span style={{ color: '#94a3b8' }}> · {e.position}</span> : null}{e.departmentName ? <span style={{ color: '#cbd5e1' }}> · {e.departmentName}</span> : null}</span>
                  </label>
                );
              })}
              {filteredEmps.length === 0 && <div style={{ color: '#6b7280', padding: 8 }}>Никого не найдено (или все уже добавлены).</div>}
              {filteredEmps.length > 500 && <div style={{ color: '#94a3b8', padding: 8, fontSize: 12 }}>Показаны первые 500 — уточните фильтр.</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
              <span style={{ flex: 1, fontSize: 12, color: '#64748b' }}>Отмечено: {pickerSel.size}</span>
              <Button variant="ghost" disabled={!filteredEmps.length} onClick={() => void addEmployees(filteredEmps)}>Добавить всех показанных</Button>
              <Button variant="primary" disabled={!pickerSel.size} onClick={() => void addEmployees(availableEmps.filter((e) => pickerSel.has(e.id)))}>Добавить отмеченных ({pickerSel.size})</Button>
            </div>
          </div>
        </div>
      )}

      {commentEdit && (
        <div onClick={() => setCommentEdit(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 16, width: 460, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <strong>Комментарий — {commentEdit.name || 'сотрудник'} · {commentEdit.day} {MONTHS[ts.month - 1]}</strong>
            <div style={{ fontSize: 12, color: '#64748b' }}>Где был / что делал в этот день (для расшифровки на печати).</div>
            <textarea
              autoFocus
              value={commentEdit.text}
              onChange={(e) => setCommentEdit((prev) => (prev ? { ...prev, text: e.target.value } : prev))}
              rows={4}
              style={{ resize: 'vertical', padding: 8, borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14 }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setCommentEdit(null)}>Отмена</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setComment(commentEdit.rowId, commentEdit.day, commentEdit.text);
                  setCommentEdit(null);
                }}
              >
                Сохранить
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function brushLabel(b: NonNullable<Brush>): string {
  if (b.kind === 'eraser') return '⌫ Резинка';
  if (b.kind === 'absence') return b.code;
  return b.hours != null ? `${b.code} · ${b.hours} ч` : b.code;
}

function chipStyle(bg: string | null, active: boolean): React.CSSProperties {
  return {
    minWidth: 28,
    height: 26,
    padding: '0 8px',
    borderRadius: 7,
    border: active ? '2px solid #2563eb' : '1px solid #cbd5e1',
    background: bg ?? '#fff',
    color: '#0b1220',
    fontWeight: 700,
    fontSize: 12,
    cursor: 'pointer',
  };
}

function segBtn(active: boolean): React.CSSProperties {
  return {
    height: 28,
    padding: '0 10px',
    border: 'none',
    borderRight: '1px solid #cbd5e1',
    background: active ? '#2563eb' : '#fff',
    color: active ? '#fff' : '#334155',
    fontWeight: 600,
    fontSize: 12,
    cursor: 'pointer',
  };
}
const fontBtn: React.CSSProperties = { height: 28, minWidth: 30, padding: '0 6px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#fff', color: '#334155', fontWeight: 700, fontSize: 12, cursor: 'pointer' };

const hCell: React.CSSProperties = { padding: '4px 3px', borderRight: '1px solid rgba(255,255,255,0.18)', textAlign: 'center', fontSize: 11, verticalAlign: 'middle' };
const bCell: React.CSSProperties = { padding: '2px 3px', border: '1px solid #e5e7eb', textAlign: 'center', verticalAlign: 'middle' };
