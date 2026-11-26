/**
 * Печатные модели наряда — по одной на «вид формы».
 *
 * До 2026-07-31 форма была одна на все типы наряда: `buildPrintModel` жила внутри
 * `WorkOrderDetailsPage`, замыкалась на семь значений карточки и различала типы одним
 * булевым `isAssembly`. Из-за этого ремонтный/обычный наряд печатался как сборочный —
 * с грифом «Утверждаю» и подписями «Работу сдал / Работу принял», которые в цеху не нужны.
 *
 * Теперь форм две:
 *  - `assembly` — наряд на сборку двигателя, поведение не менялось;
 *  - `simple`   — обычный / ремонтный / изготовление: бригада с колонкой под роспись,
 *                 услуги со стоимостью и КТУ, клеймо детали, согласующие внизу.
 *
 * Вынос из компонента дал ещё и тестируемость: зависимости теперь явный параметр `deps`.
 */

import {
  HUMAN_LABEL_DASH,
  WORK_ORDER_PRINT_FONT_DEFAULTS,
  WorkOrderKind,
  formatEmployeeInitialsSurname,
  getWorkOrderSignatureBlocks,
  pickHumanText,
  resolveAssemblyEngineId,
  resolveWorkOrderApprover,
  resolveWorkOrderSignatureSlots,
  workOrderDateMode,
  workOrderLineAssigneeId,
  workOrderLineDate,
  workOrderPeriods,
  type WorkOrderDateMode,
  type WorkOrderPayload,
  type WorkOrderPrintSettings,
  type WorkOrderSignatureSlot,
  type WorkOrderWorkLine,
} from '@matricarmz/shared';

import { formatMoscowDate, formatMoscowDayMonthName } from './dateUtils.js';
import { escapeHtml, type PrintSection } from './printPreview.js';

export type WoPrintEmployee = {
  id: string;
  fullName?: string;
  lastName?: string;
  firstName?: string;
  middleName?: string;
  displayName: string;
  personnelNumber?: string | null;
  departmentName?: string | null;
  workshopId?: string | null;
  position?: string | null;
};

export type WoPrintEngine = {
  id: string;
  engineNumber?: string;
  engineInternalNumber?: string;
  engineBrandName?: string;
  /** Сквозной номер карточки — «№ дв.», когда документного номера нет. */
  rmzCode?: string;
};

export type WoPrintDeps = {
  employees: readonly WoPrintEmployee[];
  engines: readonly WoPrintEngine[];
  parts: readonly { id: string; name: string; article?: string }[];
  workshops: readonly { id: string; name: string }[];
  warehouseLocations: readonly { id: string; code: string; name: string }[];
  /** Реквизиты контракта по двигателю: суффикс номера (*NNN) + контрагент. */
  engineContractInfo: Readonly<Record<string, { contractSuffix: string; counterparty: string }>>;
  /** Поля, скрытые применённым шаблоном наряда (serviceName / priceRub / amountRub). */
  hiddenFields: ReadonlySet<string>;
};

export type WoPrintModel = {
  title: string;
  subtitle: string;
  extraCss: string;
  sections: PrintSection[];
};

type MetaCol = { label: string; value: string };

/**
 * Колонка печатной таблицы наряда.
 *
 * `weight` — доля ширины таблицы (пропорция, не процент): колонки делят лист по этим
 * весам, поэтому ни одна колонка не может вылезти за край. Раньше ширины задавал
 * браузер сам, и длинное наименование изделия выдавливало «Цену» и «Сумму» за лист.
 */
type WoColumn = {
  label: string;
  weight: number;
  value: (line: WorkOrderWorkLine) => string;
};

/** `<colgroup>` с шириной колонок в процентах (сумма — ровно 100). */
function colgroupHtml(columns: WoColumn[]): string {
  const total = columns.reduce((acc, c) => acc + Math.max(0, c.weight), 0);
  if (total <= 0) return '';
  return `<colgroup>${columns
    .map((c) => `<col style="width:${((Math.max(0, c.weight) / total) * 100).toFixed(3)}%">`)
    .join('')}</colgroup>`;
}

/**
 * Ширина колонок таблицы бригады. Колонка «Подпись» — самая широкая: под роспись
 * должно хватать места (минимум 34 мм, см. `td.wo-sign-cell` в `baseExtraCss`).
 */
function crewColgroup(showCrewSign: boolean, withFreeze: boolean): string {
  const weights = showCrewSign
    ? withFreeze
      ? [26, 10, 7, 17, 12, 28]
      : [28, 10, 8, 18, 36]
    : withFreeze
      ? [40, 18, 14, 28]
      : [46, 20, 16, 30];
  const total = weights.reduce((acc, w) => acc + w, 0);
  return `<colgroup>${weights.map((w) => `<col style="width:${((w / total) * 100).toFixed(3)}%">`).join('')}</colgroup>`;
}

/** Таблица видов работ: фиксированная ширина колонок + перенос длинных значений. */
function worksTableHtml(columns: WoColumn[], lines: WorkOrderWorkLine[]): string {
  if (!lines.length) return `<div class="muted">Нет данных</div>`;
  const head = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const body = lines
    .map((line) => {
      const cells = columns
        .map((c) => {
          const raw = c.value(line);
          const text = raw === '' ? '—' : raw;
          return `<td>${escapeHtml(text)}</td>`;
        })
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table>${colgroupHtml(columns)}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* -------------------------------------------------------------------------- *
 * Даты выполнения работ (промт КАРМАНА #165).
 *
 * Два режима наряда:
 *  - «период»   — общий период («с 13 мая по 2 июня»), у отдельных работ дат нет;
 *  - «ежедневно» — своя дата у каждой работы, рядом видно, кому она принадлежит.
 *
 * Дата выполнения НАРЯДА (`completedDate`) — другая величина, она тут не участвует:
 * наряд по-прежнему закрывается и считается как раньше.
 * -------------------------------------------------------------------------- */

/** Период одной строки реквизитов: «с 13 мая по 2 июня». */
function periodLabel(from: number, to: number): string {
  const fromText = formatMoscowDayMonthName(from);
  if (!Number.isFinite(to) || to <= 0 || to === from) return `с ${fromText}`;
  return `с ${fromText} по ${formatMoscowDayMonthName(to)}`;
}

type WoDateContext = {
  /** Режим дат наряда; null — дат нет (старый наряд) ⇒ печатать нечего. */
  mode: WorkOrderDateMode | null;
  /** Общий период наряда — печатается в реквизитах шапки. */
  commonPeriod: { from: number; to: number } | null;
  /** Периоды по сотрудникам бригады — печатаются отдельной строкой реквизитов. */
  employeePeriods: Array<{ employeeId: string; label: string; text: string }>;
  /** Печатать в таблице работ колонку «Дата» (режим «ежедневно»). */
  showLineDate: boolean;
  /** Печатать в таблице работ колонку «Исполнитель». */
  showLineAssignee: boolean;
  /** Подпись исполнителя работы по id сотрудника бригады. */
  assigneeLabel: (employeeId: string) => string;
  /** Дата работы строкой для печати («13 мая»). */
  lineDateText: (line: WorkOrderWorkLine) => string;
  /** Исполнитель работы строкой для печати. */
  lineAssigneeText: (line: WorkOrderWorkLine) => string;
};

function buildDateContext(current: WorkOrderPayload, deps: WoPrintDeps): WoDateContext {
  const mode = workOrderDateMode(current);
  const periods = workOrderPeriods(current);
  const assigneeLabel = (employeeId: string): string => {
    const member = current.crew.find((m) => String(m.employeeId ?? '').trim() === String(employeeId ?? '').trim());
    if (member) return crewMemberLabel(member, deps);
    const employee = deps.employees.find((e) => e.id === String(employeeId ?? '').trim());
    return employee ? formatEmployeeInitialsSurname(employee) : '';
  };
  // Общий период наряда печатается только в режиме «период»: в режиме «ежедневно»
  // у каждой работы своя дата, и общий период сбивал бы с толку.
  const common = mode === 'period' ? periods.find((p) => !p.employeeId) ?? null : null;
  // Период по сотруднику печатается в обоих режимах: в бригаде один может работать
  // по дням, а другой — закрывать наряд за период.
  const employeePeriods = periods
    .filter((p) => p.employeeId)
    .map((p) => ({
      employeeId: p.employeeId,
      label: assigneeLabel(p.employeeId) || p.employeeId,
      text: periodLabel(p.from, p.to),
    }));
  const lines = current.freeWorks;
  const hasAssignees = lines.some((line) => workOrderLineAssigneeId(line) !== null);
  return {
    mode,
    commonPeriod: common ? { from: common.from, to: common.to } : null,
    employeePeriods,
    // Колонка «Дата» — только в режиме «ежедневно»: в режиме «период» у отдельных
    // работ дат нет, и лишняя колонка с прочерками только шумит на листе.
    // В режиме «ежедневно» колонка есть всегда — иначе оператор увидит в карточке
    // поле «Дата», а на наряде — нет, и решит, что даты не печатаются.
    showLineDate: mode === 'daily',
    // «Исполнитель» — когда в бригаде больше одного человека: тогда видно, чья
    // это дата, и даты сотрудников не смешиваются.
    showLineAssignee: mode === 'daily' && (hasAssignees || current.crew.length > 1),
    assigneeLabel,
    lineDateText: (line) => {
      const ms = workOrderLineDate(line);
      return ms ? formatMoscowDayMonthName(ms) : '';
    },
    lineAssigneeText: (line) => {
      const id = workOrderLineAssigneeId(line);
      return id ? assigneeLabel(id) : '';
    },
  };
}

/** Строка реквизитов «Период» (+ периоды по сотрудникам), если они заданы. */
function periodMetaRows(dates: WoDateContext): MetaCol[] {
  const rows: MetaCol[] = [];
  if (dates.commonPeriod) {
    rows.push({ label: 'Период', value: periodLabel(dates.commonPeriod.from, dates.commonPeriod.to) });
  }
  for (const period of dates.employeePeriods) {
    rows.push({ label: `Период · ${period.label}`, value: period.text });
  }
  return rows;
}

function money(v: number) {
  return `${Math.round((Number(v) || 0) * 100) / 100} ₽`;
}

function fontSizes(settings: WorkOrderPrintSettings) {
  return {
    director: settings.fontDirector ?? WORK_ORDER_PRINT_FONT_DEFAULTS.director,
    title: settings.fontTitle ?? WORK_ORDER_PRINT_FONT_DEFAULTS.title,
    meta: settings.fontMeta ?? WORK_ORDER_PRINT_FONT_DEFAULTS.meta,
    crew: settings.fontCrew ?? WORK_ORDER_PRINT_FONT_DEFAULTS.crew,
    works: settings.fontWorks ?? WORK_ORDER_PRINT_FONT_DEFAULTS.works,
    signatures: settings.fontSignatures ?? WORK_ORDER_PRINT_FONT_DEFAULTS.signatures,
  };
}

type Fonts = ReturnType<typeof fontSizes>;

function distinctTrimmed(vals: Array<string | null | undefined>): string[] {
  return Array.from(new Set(vals.map((v) => String(v ?? '').trim()).filter(Boolean)));
}

function resolvePartName(line: WorkOrderWorkLine, deps: WoPrintDeps): string {
  const stored = String(line.partName ?? '').trim();
  if (stored) return stored;
  const partId = String(line.partId ?? '').trim();
  if (!partId) return '';
  return deps.parts.find((p) => p.id === partId)?.name ?? '';
}

function resolvePartArticle(line: WorkOrderWorkLine, deps: WoPrintDeps): string {
  const stored = String(line.partArticle ?? '').trim();
  if (stored) return stored;
  const partId = String(line.partId ?? '').trim();
  if (!partId) return '';
  return deps.parts.find((p) => p.id === partId)?.article ?? '';
}

/** Клейма экземпляров строки («№ детали») одной строкой. */
function resolveStampedNumbers(line: WorkOrderWorkLine): string {
  return (line.stampedNumbers ?? []).map((v) => String(v ?? '').trim()).filter(Boolean).join(', ');
}

/**
 * Бригадник в наряде печатается как «Фамилия И.О.» + отдельная колонка табельного номера
 * (просьба владельца 2026-08-12): в цеху состав сверяют по табельному, а не по полному ФИО.
 * Порядок фиксирован — сначала фамилия, потом инициалы; общий `formatEmployeeInitialsSurname`
 * даёт обратный порядок и используется в подписях, его не трогаем.
 */
function crewMemberLabel(member: { employeeId?: string; employeeName?: string }, deps: WoPrintDeps): string {
  const employee = deps.employees.find((e) => e.id === String(member.employeeId ?? '').trim());
  const last = String(employee?.lastName ?? '').trim();
  if (last) {
    const initials = [employee?.firstName, employee?.middleName]
      .map((p) => String(p ?? '').trim())
      .filter(Boolean)
      .map((p) => `${p[0]?.toUpperCase()}.`)
      .join('');
    return initials ? `${last} ${initials}` : last;
  }
  return String(member.employeeName ?? '').trim() || String(employee?.displayName ?? '').trim();
}

/** Табельный номер бригадника; пусто — если в карточке сотрудника его нет. */
function crewMemberPersonnelNumber(member: { employeeId?: string }, deps: WoPrintDeps): string {
  const employee = deps.employees.find((e) => e.id === String(member.employeeId ?? '').trim());
  return String(employee?.personnelNumber ?? '').trim();
}

/** Подразделение подписанта: цех (по workshop_id) если задан, иначе подразделение. */
function resolveEmployeeUnit(employee: WoPrintEmployee | undefined, deps: WoPrintDeps): string {
  if (!employee) return '';
  const wsId = String(employee.workshopId ?? '').trim();
  if (wsId) {
    const ws = deps.workshops.find((w) => w.id === wsId);
    if (ws?.name) return ws.name;
  }
  return String(employee.departmentName ?? '').trim();
}

/** Одна строка-подпись: роль сверху, линия под роспись, справа расшифровка и должность снизу. */
function signCell(slot: WorkOrderSignatureSlot, deps: WoPrintDeps, fs: Fonts): string {
  const employeeById = new Map(deps.employees.map((e) => [e.id, e] as const));
  const caption = String(slot.caption ?? '').trim();
  const employee = slot.employeeId ? employeeById.get(slot.employeeId) : undefined;
  const name = employee ? formatEmployeeInitialsSurname(employee) : '';
  const sigName = fs.signatures;
  const sigCap = Math.max(9, fs.signatures - 1);
  const sigPos = Math.max(9, fs.signatures - 2);
  const positionLine = [String(employee?.position ?? '').trim(), resolveEmployeeUnit(employee, deps)]
    .filter(Boolean)
    .join(' · ');
  const nameCell = name
    ? `<span style="font-size:${sigName}px;white-space:nowrap;">${escapeHtml(name)}</span>`
    : `<span style="display:inline-block;width:120px;border-bottom:1px solid #94a3b8;"></span>`;
  return `<div style="width:100%;margin:2px 0 0;">${
    caption ? `<div style="font-size:${sigCap}px;color:#334155;margin-bottom:1px;">${escapeHtml(caption)}</div>` : ''
  }<div style="display:flex;align-items:flex-end;gap:8px;"><span style="flex:1;border-bottom:1px solid #0f172a;height:12px;"></span>${nameCell}</div><div style="text-align:center;font-size:${sigPos}px;color:#64748b;margin-top:1px;min-height:10px;">${escapeHtml(
    positionLine,
  )}</div></div>`;
}

/**
 * Блоки подписей. Блок без слотов не печатается; если не печатается ни один — секция
 * подписей не создаётся вовсе (раньше внешний flex-контейнер строился безусловно, и
 * пустая секция всё равно попадала в отпечаток вопреки комментарию в коде).
 *
 * Слоты одного блока, если блок на листе один, идут в две колонки: четыре слота
 * «Согласовано» в столбик съедали 61 мм высоты — треть печатной области листа.
 */
function buildSignaturesHtml(
  payload: WorkOrderPayload,
  settings: WorkOrderPrintSettings,
  deps: WoPrintDeps,
  fs: Fonts,
): string {
  if (settings.hideSignatures) return '';
  const hidden = new Set(settings.hideSignatureBlocks ?? []);
  const sigTitle = fs.signatures + 1;
  const sigName = fs.signatures;
  const blocks = getWorkOrderSignatureBlocks(payload.workOrderKind)
    .map((def) => {
      if (hidden.has(def.id)) return null;
      const slots = resolveWorkOrderSignatureSlots(def, payload.signatureBlocks);
      if (!slots.length) return null;
      const dateLine = def.dateLineLabel
        ? `<div style="font-size:${sigName}px;margin:1px 0 2px;">${escapeHtml(
            def.dateLineLabel,
          )}: <span style="display:inline-block;min-width:110px;border-bottom:1px solid #0f172a;"></span></div>`
        : '';
      return {
        title: `<div style="font-weight:700;font-size:${sigTitle}px;margin-bottom:1px;">${escapeHtml(def.title)}</div>`,
        dateLine,
        slots: slots.map((slot) => signCell(slot, deps, fs)).join(''),
      };
    })
    .filter((b): b is { title: string; dateLine: string; slots: string } => b !== null);
  if (!blocks.length) return '';
  // Один блок на всю ширину листа — слоты в две колонки: четыре слота «Согласовано»
  // в столбик съедали 61 мм высоты (треть печатной области листа). Несколько блоков
  // в ряд — каждый узкий, там слоты остаются в столбик.
  if (blocks.length === 1) {
    const only = blocks[0]!;
    return `<div style="break-inside:avoid-page;page-break-inside:avoid;">${only.title}${only.dateLine}<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px;">${only.slots}</div></div>`;
  }
  return `<div style="display:flex;gap:4%;align-items:flex-start;">${blocks
    .map(
      (b) =>
        `<div style="flex:1;min-width:0;break-inside:avoid-page;page-break-inside:avoid;">${b.title}${b.dateLine}${b.slots}</div>`,
    )
    .join('')}</div>`;
}

/**
 * Реквизиты шапки: «этажи» по два ряда (подпись — значение). Таблица фиксированной
 * ширины, поэтому в коротком этаже недостающие ячейки добиваются пустыми (иначе
 * колонки разъедутся). Порядок рядов — как был: подпись этажа, затем его значения.
 */
function metaTableHtml(tiers: MetaCol[][]): string {
  const rows = tiers.filter((tier) => tier.length > 0);
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((tier) => tier.length));
  const body = rows
    .map((tier) => {
      const heads = tier.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('') + '<th></th>'.repeat(cols - tier.length);
      const values = tier.map((c) => `<td>${escapeHtml(c.value)}</td>`).join('') + '<td></td>'.repeat(cols - tier.length);
      return `<tr>${heads}</tr><tr>${values}</tr>`;
    })
    .join('');
  return `<table class="wo-meta"><tbody>${body}</tbody></table>`;
}

function baseExtraCss(fs: Fonts): string[] {
  return [
    `.section { margin-bottom: 6px; }`,
    `th, td { padding: 1px 4px; }`,
    `[data-print-section="meta"] table.wo-meta { width: 100%; border-collapse: collapse; table-layout: fixed; }`,
    `[data-print-section="meta"] table.wo-meta th, [data-print-section="meta"] table.wo-meta td { border: 1px solid #0f172a; text-align: center; font-size: ${fs.meta}px; padding: 1px 4px; word-break: break-word; overflow-wrap: anywhere; line-height: 1.15; }`,
    `[data-print-section="meta"] table.wo-meta th { background: #f3f4f6; font-weight: 600; font-size: ${Math.max(10, fs.meta - 1)}px; }`,
    `[data-print-section="crew"] td, [data-print-section="crew"] th { font-size: ${fs.crew}px; }`,
    `[data-print-section="works"] td, [data-print-section="works"] th { font-size: ${fs.works}px; }`,
    `[data-print-section="crew"] table, [data-print-section="works"] table { border-collapse: collapse; table-layout: fixed; }`,
    `[data-print-section="crew"] th, [data-print-section="crew"] td, [data-print-section="works"] th, [data-print-section="works"] td { border: 1px solid #0f172a; }`,
    `[data-print-section="crew"] th, [data-print-section="works"] th { background: #f3f4f6; }`,
    // Ширина колонок — долями от ширины листа (colgroup), а не «как получится».
    // Без этого длинное наименование изделия распирает таблицу, колонки «Цена»/«Сумма»
    // уходят за край листа и на принтере режутся.
    `[data-print-section="crew"] td, [data-print-section="crew"] th, [data-print-section="works"] td, [data-print-section="works"] th { overflow-wrap: anywhere; word-break: break-word; }`,
    // Плотный межстрочный интервал в таблицах работ: строки работы — их на наряде
    // десятки, и каждый лишний миллиметр высоты уводит лист на вторую страницу.
    `[data-print-section="works"] td, [data-print-section="works"] th { line-height: 1.18; }`,
    // Шапка таблицы повторяется на каждом листе: если наряд всё же не влез в один лист
    // (12+ длинных строк), второй лист читается — продолжать видно, что за строка.
    `[data-print-section="works"] thead, [data-print-section="crew"] thead { display: table-header-group; }`,
    // Подписи идут сразу за телом наряда (тянутся кверху), с заметным отступом от
    // последнего блока — но НЕ прижимаются к низу листа: прежний bottom-pin выталкивал
    // блок подписей на 2-ю страницу.
    `[data-print-section="signatures"] { margin-top: 10px; }`,
    // Ячейка под роспись бригады — пустая, но с гарантированной шириной и высотой:
    // иначе браузер схлопывает её в нитку и расписаться негде.
    `[data-print-section="crew"] table.wo-crew td.wo-sign-cell { min-width: 34mm; height: 9mm; }`,
    // Поля печати задаёт @page (12мм) — те же, что у предпросмотра A4, поэтому
    // лист на печати и лист в окне печати совпадают. Поля @page обнулять нельзя:
    // без них содержимое упирается в край бумаги и принтер срезает края.
    `@page { size: A4; margin: 12mm; }`,
    `@media print { body { margin: 0; } }`,
  ];
}

/** Реквизиты контракта берём по первому двигателю наряда. */
function contractInfoForPayload(payload: WorkOrderPayload, deps: WoPrintDeps) {
  const firstEngineId =
    payload.freeWorks.map((l) => String(l.engineId ?? '').trim()).find(Boolean) ??
    resolveAssemblyEngineId(payload) ??
    '';
  return firstEngineId ? deps.engineContractInfo[firstEngineId] : undefined;
}

// ────────────────────────────────── Наряд на сборку ──────────────────────────────────

function buildAssemblyModel(
  current: WorkOrderPayload,
  settings: WorkOrderPrintSettings,
  deps: WoPrintDeps,
): WoPrintModel {
  const fs = fontSizes(settings);
  // Дата печати всегда = дата наряда: сохранённые orderDateOverride (в т.ч. залипшие
  // от старых клиентов/умолчаний) игнорируются — «застрявшая» дата и была этой граблей.
  const printDate = current.orderDate;
  // Даты выполнения работ (режим «период» / «ежедневно»).
  const dates = buildDateContext(current, deps);

  // Марка/№ двигателя и вид работ одинаковы во всех строках — выносим их в шапку и
  // убираем повторяющиеся колонки из таблицы работ. Фоллбек на двигатель шапки
  // (payload.assemblyEngineId): построчные штампы могли быть стрижены normalizeWorkOrderLine.
  const headerEngineFromPayload = (() => {
    const engineId = resolveAssemblyEngineId(current);
    return engineId ? deps.engines.find((e) => e.id === engineId) ?? null : null;
  })();
  const headerEngineBrand =
    distinctTrimmed(current.freeWorks.map((l) => l.engineBrandName)).join(', ') ||
    String(headerEngineFromPayload?.engineBrandName ?? '').trim() ||
    '—';
  const headerEngineNumber =
    distinctTrimmed(current.freeWorks.map((l) => l.engineNumber)).join(', ') ||
    String(headerEngineFromPayload?.engineNumber ?? '').trim() ||
    String(headerEngineFromPayload?.rmzCode ?? '').trim() ||
    '—';
  const headerEngineInternalNumber =
    distinctTrimmed(current.freeWorks.map((l) => l.engineInternalNumber)).join(', ') ||
    String(headerEngineFromPayload?.engineInternalNumber ?? '').trim() ||
    '';
  const headerWorkTypes = distinctTrimmed(current.freeWorks.map((l) => l.serviceName));
  const headerWorkType = headerWorkTypes.length === 1 ? headerWorkTypes[0]! : 'Сборка двигателя';

  const warehouseNameById = new Map(deps.warehouseLocations.map((w) => [w.id, w.name]));
  const warehouseNameByCode = new Map(deps.warehouseLocations.map((w) => [w.code, w.name]));
  const resolveSourceWarehouseName = (rawId: string | null | undefined) => {
    const raw = String(rawId ?? '').trim();
    if (!raw) return 'Склад цеха (по умолчанию)';
    const byId = raw.includes('-') && raw.length >= 32 ? warehouseNameById.get(raw) : undefined;
    // Неопознанный идентификатор в наряд не печатаем: наименование склада оператор
    // читает, а `8f14e45f-…` в колонке «Склад» — это утечка, а не данные.
    return pickHumanText(byId, warehouseNameByCode.get(raw), raw) || HUMAN_LABEL_DASH;
  };

  const linesTable = (lines: WorkOrderWorkLine[]) => {
    if (!lines.length) return `<div class="muted">Нет данных</div>`;
    // Колонки, пустые во ВСЕХ строках, из печати исключаются (решение владельца 2026-07-13):
    // пустая колонка на листе — шум, съедающий ширину у заполненных.
    const hasAny = (get: (line: WorkOrderWorkLine) => string | null | undefined) =>
      lines.some((l) => String(get(l) ?? '').trim());
    const articleCol = hasAny((l) => resolvePartArticle(l, deps));
    const productNumberCol = hasAny((l) => l.productNumber);
    const columns: WoColumn[] = [
      { label: 'Наименование изделия', weight: 31, value: (line) => resolvePartName(line, deps) },
      ...(articleCol ? [{ label: 'Артикул', weight: 11, value: (line: WorkOrderWorkLine) => resolvePartArticle(line, deps) }] : []),
      ...(productNumberCol ? [{ label: '№ изделия', weight: 9, value: (line: WorkOrderWorkLine) => String(line.productNumber ?? '') }] : []),
      ...(dates.showLineDate
        ? [{ label: 'Дата', weight: 13, value: (line: WorkOrderWorkLine) => dates.lineDateText(line) }]
        : []),
      ...(dates.showLineAssignee
        ? [{ label: 'Исполнитель', weight: 16, value: (line: WorkOrderWorkLine) => dates.lineAssigneeText(line) }]
        : []),
      { label: 'Кол-во', weight: 6, value: (line) => String(line.qty ?? 0) },
      // Единице измерения ширины надо ровно на перенос: в узкой колонке «нормо-час»
      // ложился на пять строк и каждая строка наряда вырастала вдвое.
      { label: 'Ед.', weight: 12, value: (line) => String(line.unit ?? '') },
      { label: 'Склад', weight: 18, value: (line) => resolveSourceWarehouseName(line.sourceWarehouseId) },
    ];
    return worksTableHtml(columns, lines);
  };

  // Бригада сборочного наряда расписывается там же, где ремонтного, — последней колонкой.
  const showCrewSign = !settings.hideCrewSignatures;
  const crewHtml = current.crew.length
    ? `<table class="wo-crew">${crewColgroup(showCrewSign, true)}<thead><tr><th>Сотрудник</th><th>Таб. №</th><th>КТУ</th><th>Начислено</th><th>Заморозка</th>${
        showCrewSign ? '<th>Подпись</th>' : ''
      }</tr></thead><tbody>${current.crew
        .map(
          (member) =>
            `<tr><td>${escapeHtml(crewMemberLabel(member, deps) || '—')}</td><td>${escapeHtml(
              crewMemberPersonnelNumber(member, deps),
            )}</td><td>${escapeHtml(
              String(member.ktu ?? 1),
            )}</td><td>${escapeHtml(money(member.payoutRub ?? 0))}</td><td>${
              member.payoutFrozen ? 'Да' : 'Нет'
            }</td>${showCrewSign ? '<td class="wo-sign-cell"></td>' : ''}</tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="muted">Нет данных</div>`;

  const worksHtml = linesTable(current.freeWorks);
  const signaturesHtml = buildSignaturesHtml(current, settings, deps, fs);

  const firstWorkType = distinctTrimmed(current.freeWorks.map((l) => l.serviceName))[0] ?? headerWorkType;
  const autoTitle = firstWorkType ? `Наряд на ${firstWorkType}` : `Наряд №${current.workOrderNumber || '—'}`;
  const headerTitle = settings.titleOverride?.trim() || autoTitle;
  const contractInfo = contractInfoForPayload(current, deps);

  // Гриф утверждения (ГОСТ Р 7.0.97 — верхний правый угол, над заголовком).
  const approvalLinePx = Math.round(160 * (fs.director / WORK_ORDER_PRINT_FONT_DEFAULTS.director));
  const approver = resolveWorkOrderApprover(settings);
  const createdDateHtml =
    settings.hideOrderDate || !printDate
      ? ''
      : `<div style="font-size:${fs.meta + 1}px;font-weight:600;">${formatMoscowDate(printDate)}</div>`;
  const approvalHtml = `<div style="display:flex;justify-content:space-between;align-items:flex-start;">${createdDateHtml}<div style="margin-left:auto;text-align:right;font-size:${fs.director}px;line-height:1.4;"><div style="font-weight:700;">Утверждаю</div><div>${escapeHtml(
    approver.position,
  )}</div><div style="margin-top:14px;"><span style="display:inline-block;width:${approvalLinePx}px;border-bottom:1px solid #0f172a;"></span>&nbsp;${escapeHtml(
    approver.name,
  )}</div></div></div>`;
  const titleHtml = `<div style="text-align:center;font-size:${fs.title}px;font-weight:700;line-height:1.25;">${escapeHtml(
    headerTitle,
  )}</div>`;

  const workshop = deps.workshops.find((w) => w.id === String(current.workshopId ?? '').trim());
  // Плановые даты — день + месяц словом («14 июля»), без года: год виден в дате создания у грифа.
  const shortDate = (ms: number | undefined) => (ms ? formatMoscowDayMonthName(ms) : '—');
  const tier1: MetaCol[] = [
    { label: '№', value: String(current.workOrderNumber || '—') },
    ...(settings.hideStartDate ? [] : [{ label: 'Приступить', value: shortDate(current.startDate) }]),
    ...(settings.hideDueDate ? [] : [{ label: 'Срок', value: shortDate(current.dueDate) }]),
    ...(settings.hideWorkshop ? [] : [{ label: 'Цех', value: workshop?.name ?? '—' }]),
  ];
  const tier2: MetaCol[] = [
    { label: 'Марка дв.', value: headerEngineBrand },
    { label: '№ дв.', value: headerEngineNumber },
    ...(headerEngineInternalNumber ? [{ label: 'Внутр. №', value: headerEngineInternalNumber }] : []),
    ...(contractInfo?.contractSuffix ? [{ label: '№ контр.', value: contractInfo.contractSuffix }] : []),
    ...(contractInfo?.counterparty ? [{ label: 'Заказчик', value: contractInfo.counterparty }] : []),
  ];
  // Период выполнения работ (режим «период») и периоды по сотрудникам — в реквизиты.
  const periodRows = periodMetaRows(dates);
  const metaHtml = metaTableHtml(periodRows.length ? [tier1, tier2, periodRows] : [tier1, tier2]);

  return {
    title: headerTitle,
    subtitle: printDate ? `Дата: ${formatMoscowDate(printDate)}` : 'Дата: —',
    extraCss: baseExtraCss(fs).join(' '),
    // Пустые блоки не печатаем: бригада/виды работ выводятся только при наличии данных.
    sections: [
      ...(settings.hideApprover ? [] : [{ id: 'director', title: 'Гриф директора', html: approvalHtml, hideTitle: true }]),
      { id: 'title', title: 'Заголовок', html: titleHtml, hideTitle: true },
      { id: 'meta', title: 'Реквизиты', html: metaHtml, hideTitle: true },
      ...(current.crew.length > 0 ? [{ id: 'crew', title: 'Бригада и выплаты', html: crewHtml, hideTitle: true }] : []),
      ...(current.freeWorks.length > 0 ? [{ id: 'works', title: 'Виды работ', html: worksHtml, hideTitle: true }] : []),
      ...(signaturesHtml ? [{ id: 'signatures', title: 'Подписи', html: signaturesHtml, hideTitle: true }] : []),
    ] as PrintSection[],
  };
}

// ───────────────────── Простой наряд: обычный / ремонт / изготовление ─────────────────────

function buildSimpleModel(
  current: WorkOrderPayload,
  settings: WorkOrderPrintSettings,
  deps: WoPrintDeps,
): WoPrintModel {
  const fs = fontSizes(settings);
  const printDate = current.orderDate;
  const showService = !deps.hiddenFields.has('serviceName');
  const showPrice = !deps.hiddenFields.has('priceRub');
  const showAmount = !deps.hiddenFields.has('amountRub');
  // Даты выполнения работ (режим «период» / «ежедневно»).
  const dates = buildDateContext(current, deps);

  // Двигатель один на весь наряд — выносим его в шапку и убираем повторяющиеся колонки
  // из строк (раньше номер и марка дублировались в каждой строке ремонтного наряда).
  const engineNumbers = distinctTrimmed(current.freeWorks.map((l) => l.engineNumber));
  const engineBrands = distinctTrimmed(current.freeWorks.map((l) => l.engineBrandName));
  const engineInternalNumbers = distinctTrimmed(current.freeWorks.map((l) => l.engineInternalNumber));
  const singleEngine = engineNumbers.length <= 1 && engineBrands.length <= 1;

  const linesTable = (lines: WorkOrderWorkLine[]) => {
    if (!lines.length) return `<div class="muted">Нет данных</div>`;
    const hasAny = (get: (line: WorkOrderWorkLine) => string | null | undefined) =>
      lines.some((l) => String(get(l) ?? '').trim());
    const engineCols = !singleEngine && (hasAny((l) => l.engineNumber) || hasAny((l) => l.engineBrandName));
    const engineInternalCol = engineCols && hasAny((l) => l.engineInternalNumber);
    const serviceCol = showService && hasAny((l) => l.serviceName);
    // «№ детали» — клеймо изготовителя, набитое на самой детали и внесённое при дефектовке.
    const stampedCol = hasAny((l) => resolveStampedNumbers(l));
    const articleCol = hasAny((l) => resolvePartArticle(l, deps));
    const productNumberCol = hasAny((l) => l.productNumber);
    // Колонки заданы весами: ширину делит таблица сама, поэтому ни одна колонка
    // не выходит за край листа (раньше ширины задавал браузер, и «Цена»/«Сумма»
    // уезжали за лист на длинных наименованиях).
    //
    // Вес колонки «Ед.» — 12: в узкой колонке «нормо-час» ложился на пять строк, и
    // каждая строка наряда от этого вырастала вдвое (измерили: 22,5 мм текста в
    // ячейке шириной 7,9 мм). Единице измерения ширины надо ровно на перенос.
    const columns: WoColumn[] = [
      ...(engineCols ? [{ label: '№ двигателя', weight: 9, value: (line: WorkOrderWorkLine) => String(line.engineNumber ?? '') }] : []),
      ...(engineInternalCol ? [{ label: 'Внутр. №', weight: 7, value: (line: WorkOrderWorkLine) => String(line.engineInternalNumber ?? '') }] : []),
      ...(engineCols ? [{ label: 'Марка', weight: 8, value: (line: WorkOrderWorkLine) => String(line.engineBrandName ?? '') }] : []),
      ...(serviceCol ? [{ label: 'Вид работ', weight: 18, value: (line: WorkOrderWorkLine) => String(line.serviceName ?? '') }] : []),
      { label: 'Наименование изделия', weight: 35, value: (line) => resolvePartName(line, deps) },
      ...(stampedCol ? [{ label: '№ детали', weight: 9, value: (line: WorkOrderWorkLine) => resolveStampedNumbers(line) }] : []),
      ...(articleCol ? [{ label: 'Артикул', weight: 9, value: (line: WorkOrderWorkLine) => resolvePartArticle(line, deps) }] : []),
      ...(productNumberCol ? [{ label: '№ изделия', weight: 7, value: (line: WorkOrderWorkLine) => String(line.productNumber ?? '') }] : []),
      ...(dates.showLineDate
        ? [{ label: 'Дата', weight: 12, value: (line: WorkOrderWorkLine) => dates.lineDateText(line) }]
        : []),
      ...(dates.showLineAssignee
        ? [{ label: 'Исполнитель', weight: 15, value: (line: WorkOrderWorkLine) => dates.lineAssigneeText(line) }]
        : []),
      { label: 'Кол-во', weight: 6, value: (line) => String(line.qty ?? 0) },
      { label: 'Ед.', weight: 12, value: (line) => String(line.unit ?? '') },
      ...(showPrice ? [{ label: 'Цена', weight: 8, value: (line: WorkOrderWorkLine) => money(line.priceRub ?? 0) }] : []),
      ...(showAmount ? [{ label: 'Сумма', weight: 9, value: (line: WorkOrderWorkLine) => money(line.amountRub ?? 0) }] : []),
    ];
    return worksTableHtml(columns, lines);
  };

  const worksHtml = `${linesTable(current.freeWorks)}${
    showAmount
      ? `<div class="wo-print-works-footer" style="margin-top:5px;padding-top:4px;border-top:1px solid #e5e7eb;font-size:12px;"><strong>Итог:</strong> ${escapeHtml(
          money(current.totalAmountRub || 0),
        )}</div>`
      : ''
  }`;

  // Бригада расписывается прямо в своей таблице: пятая колонка — пустая ячейка под роспись.
  // Отдельных слотов подписи на бригаду не заводим — их число заранее неизвестно, а
  // колонка растёт вместе с составом сама.
  const showCrewSign = !settings.hideCrewSignatures;
  const crewHtml = current.crew.length
    ? `<table class="wo-crew">${crewColgroup(showCrewSign, false)}<thead><tr><th>Сотрудник</th><th>Таб. №</th><th>КТУ</th>${
        showAmount ? '<th>Начислено</th>' : ''
      }${showCrewSign ? '<th>Подпись</th>' : ''}</tr></thead><tbody>${current.crew
        .map(
          (member) =>
            `<tr><td>${escapeHtml(crewMemberLabel(member, deps) || '—')}</td><td>${escapeHtml(
              crewMemberPersonnelNumber(member, deps),
            )}</td><td>${escapeHtml(String(member.ktu ?? 1))}</td>${
              showAmount ? `<td>${escapeHtml(money(member.payoutRub ?? 0))}</td>` : ''
            }${showCrewSign ? '<td class="wo-sign-cell"></td>' : ''}</tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="muted">Нет данных</div>`;

  const signaturesHtml = buildSignaturesHtml(current, settings, deps, fs);

  const firstWorkType = distinctTrimmed(current.freeWorks.map((l) => l.serviceName))[0] ?? '';
  const autoTitle = firstWorkType
    ? `Наряд №${current.workOrderNumber || '—'} на ${firstWorkType}`
    : `Наряд №${current.workOrderNumber || '—'}`;
  const headerTitle = settings.titleOverride?.trim() || autoTitle;
  const titleHtml = `<div style="text-align:center;font-size:${fs.title}px;font-weight:700;line-height:1.25;">${escapeHtml(
    headerTitle,
  )}</div>`;

  const workshop = deps.workshops.find((w) => w.id === String(current.workshopId ?? '').trim());
  const shortDate = (ms: number | undefined) => (ms ? formatMoscowDayMonthName(ms) : '—');
  const contractInfo = contractInfoForPayload(current, deps);
  // Грифа «Утверждаю» в простой форме нет, поэтому дата наряда переезжает в реквизиты —
  // иначе на листе не остаётся года.
  const tier1: MetaCol[] = [
    ...(settings.hideOrderDate || !printDate ? [] : [{ label: 'Дата', value: formatMoscowDate(printDate) }]),
    ...(settings.hideStartDate ? [] : [{ label: 'Приступить', value: shortDate(current.startDate) }]),
    ...(settings.hideDueDate ? [] : [{ label: 'Срок', value: shortDate(current.dueDate) }]),
    ...(settings.hideWorkshop ? [] : [{ label: 'Цех', value: workshop?.name ?? '—' }]),
  ];
  const tier2: MetaCol[] = [
    ...(singleEngine && engineNumbers.length === 1 ? [{ label: '№ дв.', value: engineNumbers[0]! }] : []),
    ...(singleEngine && engineInternalNumbers.length === 1
      ? [{ label: 'Внутр. №', value: engineInternalNumbers[0]! }]
      : []),
    ...(singleEngine && engineBrands.length === 1 ? [{ label: 'Марка дв.', value: engineBrands[0]! }] : []),
    ...(contractInfo?.contractSuffix ? [{ label: '№ контр.', value: contractInfo.contractSuffix }] : []),
    ...(contractInfo?.counterparty ? [{ label: 'Заказчик', value: contractInfo.counterparty }] : []),
  ];
  const metaHtml = metaTableHtml(periodMetaRows(dates).length ? [tier1, tier2, periodMetaRows(dates)] : [tier1, tier2]);

  return {
    title: headerTitle,
    subtitle: printDate ? `Дата: ${formatMoscowDate(printDate)}` : 'Дата: —',
    extraCss: baseExtraCss(fs).join(' '),
    sections: [
      { id: 'title', title: 'Заголовок', html: titleHtml, hideTitle: true },
      { id: 'meta', title: 'Реквизиты', html: metaHtml, hideTitle: true },
      ...(current.freeWorks.length > 0 ? [{ id: 'works', title: 'Виды работ', html: worksHtml, hideTitle: true }] : []),
      ...(current.crew.length > 0 ? [{ id: 'crew', title: 'Бригада', html: crewHtml, hideTitle: true }] : []),
      ...(signaturesHtml ? [{ id: 'signatures', title: 'Подписи', html: signaturesHtml, hideTitle: true }] : []),
    ] as PrintSection[],
  };
}

/** Печатная модель наряда: форма выбирается по типу наряда. */
export function buildWorkOrderPrintModel(
  current: WorkOrderPayload,
  settings: WorkOrderPrintSettings,
  deps: WoPrintDeps,
): WoPrintModel {
  return current.workOrderKind === WorkOrderKind.Assembly
    ? buildAssemblyModel(current, settings, deps)
    : buildSimpleModel(current, settings, deps);
}
