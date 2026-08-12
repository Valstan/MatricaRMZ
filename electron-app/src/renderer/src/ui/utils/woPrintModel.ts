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
  WORK_ORDER_PRINT_FONT_DEFAULTS,
  WorkOrderKind,
  formatEmployeeInitialsSurname,
  getWorkOrderSignatureBlocks,
  resolveAssemblyEngineId,
  resolveWorkOrderApprover,
  resolveWorkOrderSignatureSlots,
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
};

export type WoPrintDeps = {
  employees: readonly WoPrintEmployee[];
  engines: readonly WoPrintEngine[];
  parts: readonly { id: string; name: string; article?: string }[];
  workshops: readonly { id: string; name: string }[];
  warehouseLocations: readonly { id: string; code: string; name: string }[];
  /** Реквизиты контракта по двигателю: суффикс номера (***NNN) + контрагент. */
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
  return `<div style="width:100%;margin:5px 0 0;">${
    caption ? `<div style="font-size:${sigCap}px;color:#334155;margin-bottom:1px;">${escapeHtml(caption)}</div>` : ''
  }<div style="display:flex;align-items:flex-end;gap:8px;"><span style="flex:1;border-bottom:1px solid #0f172a;height:14px;"></span>${nameCell}</div><div style="text-align:center;font-size:${sigPos}px;color:#64748b;margin-top:1px;min-height:11px;">${escapeHtml(
    positionLine,
  )}</div></div>`;
}

/**
 * Блоки подписей. Блок без слотов не печатается; если не печатается ни один — секция
 * подписей не создаётся вовсе (раньше внешний flex-контейнер строился безусловно, и
 * пустая секция всё равно попадала в отпечаток вопреки комментарию в коде).
 */
function buildSignaturesHtml(payload: WorkOrderPayload, deps: WoPrintDeps, fs: Fonts): string {
  const sigTitle = fs.signatures + 1;
  const sigName = fs.signatures;
  const blocks = getWorkOrderSignatureBlocks(payload.workOrderKind)
    .map((def) => {
      const slots = resolveWorkOrderSignatureSlots(def, payload.signatureBlocks);
      if (!slots.length) return '';
      const dateLine = def.dateLineLabel
        ? `<div style="font-size:${sigName}px;margin:1px 0 2px;">${escapeHtml(
            def.dateLineLabel,
          )}: <span style="display:inline-block;min-width:110px;border-bottom:1px solid #0f172a;"></span></div>`
        : '';
      return `<div style="flex:1;min-width:0;break-inside:avoid-page;page-break-inside:avoid;"><div style="font-weight:700;font-size:${sigTitle}px;margin-bottom:1px;">${escapeHtml(
        def.title,
      )}</div>${dateLine}${slots.map((slot) => signCell(slot, deps, fs)).join('')}</div>`;
    })
    .filter(Boolean);
  if (!blocks.length) return '';
  return `<div style="display:flex;gap:4%;align-items:flex-start;">${blocks.join('')}</div>`;
}

function metaTier(cols: MetaCol[]): string {
  return cols.length
    ? `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead><tbody><tr>${cols
        .map((c) => `<td>${escapeHtml(c.value)}</td>`)
        .join('')}</tr></tbody>`
    : '';
}

function baseExtraCss(fs: Fonts): string[] {
  return [
    `.section { margin-bottom: 14px; }`,
    `th, td { padding: 2px 7px; }`,
    `[data-print-section="meta"] table.wo-meta { width: 100%; border-collapse: collapse; }`,
    `[data-print-section="meta"] table.wo-meta th, [data-print-section="meta"] table.wo-meta td { border: 1px solid #0f172a; text-align: center; font-size: ${fs.meta}px; padding: 3px 8px; word-break: break-word; }`,
    `[data-print-section="meta"] table.wo-meta th { background: #f3f4f6; font-weight: 600; }`,
    `[data-print-section="crew"] td, [data-print-section="crew"] th { font-size: ${fs.crew}px; }`,
    `[data-print-section="works"] td, [data-print-section="works"] th { font-size: ${fs.works}px; }`,
    `[data-print-section="crew"] table, [data-print-section="works"] table { border-collapse: collapse; }`,
    `[data-print-section="crew"] th, [data-print-section="crew"] td, [data-print-section="works"] th, [data-print-section="works"] td { border: 1px solid #0f172a; }`,
    `[data-print-section="crew"] th, [data-print-section="works"] th { background: #f3f4f6; }`,
    // Подписи идут сразу за телом наряда (тянутся кверху), с заметным отступом от
    // последнего блока — но НЕ прижимаются к низу листа: прежний bottom-pin выталкивал
    // блок подписей на 2-ю страницу.
    `[data-print-section="signatures"] { margin-top: 24px; }`,
    // Поля печати задаёт body (12мм, PRINT_BASE_CSS) — поля @page обнуляем, иначе браузер
    // добавит свои сверху и вытолкнет контент на 2-й лист.
    `@page { size: A4; margin: 0; }`,
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
    return byId ?? warehouseNameByCode.get(raw) ?? raw;
  };

  const linesTable = (lines: WorkOrderWorkLine[]) => {
    if (!lines.length) return `<div class="muted">Нет данных</div>`;
    // Колонки, пустые во ВСЕХ строках, из печати исключаются (решение владельца 2026-07-13):
    // пустая колонка на листе — шум, съедающий ширину у заполненных.
    const hasAny = (get: (line: WorkOrderWorkLine) => string | null | undefined) =>
      lines.some((l) => String(get(l) ?? '').trim());
    const articleCol = hasAny((l) => resolvePartArticle(l, deps));
    const productNumberCol = hasAny((l) => l.productNumber);
    return `<table><thead><tr><th>Наименование изделия</th>${articleCol ? '<th>Артикул</th>' : ''}${
      productNumberCol ? '<th>№ изделия</th>' : ''
    }<th>Кол-во</th><th>Ед.</th><th>Склад</th></tr></thead><tbody>${lines
      .map(
        (line) =>
          `<tr><td>${escapeHtml(resolvePartName(line, deps) || '—')}</td>${
            articleCol ? `<td>${escapeHtml(resolvePartArticle(line, deps) || '—')}</td>` : ''
          }${productNumberCol ? `<td>${escapeHtml(line.productNumber || '—')}</td>` : ''}<td>${escapeHtml(
            String(line.qty ?? 0),
          )}</td><td>${escapeHtml(line.unit || '—')}</td><td>${escapeHtml(
            resolveSourceWarehouseName(line.sourceWarehouseId),
          )}</td></tr>`,
      )
      .join('')}</tbody></table>`;
  };

  const crewHtml = current.crew.length
    ? `<table><thead><tr><th>Сотрудник</th><th>Таб. №</th><th>КТУ</th><th>Начислено</th><th>Заморозка</th></tr></thead><tbody>${current.crew
        .map(
          (member) =>
            `<tr><td>${escapeHtml(crewMemberLabel(member, deps) || '—')}</td><td>${escapeHtml(
              crewMemberPersonnelNumber(member, deps),
            )}</td><td>${escapeHtml(
              String(member.ktu ?? 1),
            )}</td><td>${escapeHtml(money(member.payoutRub ?? 0))}</td><td>${
              member.payoutFrozen ? 'Да' : 'Нет'
            }</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="muted">Нет данных</div>`;

  const worksHtml = linesTable(current.freeWorks);
  const signaturesHtml = buildSignaturesHtml(current, deps, fs);

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
  const metaHtml = `<table class="wo-meta">${metaTier(tier1)}${metaTier(tier2)}</table>`;

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
    const head = [
      ...(engineCols ? ['№ двигателя'] : []),
      ...(engineInternalCol ? ['Внутр. №'] : []),
      ...(engineCols ? ['Марка'] : []),
      ...(serviceCol ? ['Вид работ'] : []),
      'Наименование изделия',
      ...(stampedCol ? ['№ детали'] : []),
      ...(articleCol ? ['Артикул'] : []),
      ...(productNumberCol ? ['№ изделия'] : []),
      'Кол-во',
      'Ед.',
      ...(showPrice ? ['Цена'] : []),
      ...(showAmount ? ['Сумма'] : []),
    ];
    const body = lines
      .map((line) => {
        const cells = [
          ...(engineCols ? [line.engineNumber || '—'] : []),
          ...(engineInternalCol ? [line.engineInternalNumber || '—'] : []),
          ...(engineCols ? [line.engineBrandName || '—'] : []),
          ...(serviceCol ? [line.serviceName || '—'] : []),
          resolvePartName(line, deps) || '—',
          ...(stampedCol ? [resolveStampedNumbers(line) || '—'] : []),
          ...(articleCol ? [resolvePartArticle(line, deps) || '—'] : []),
          ...(productNumberCol ? [line.productNumber || '—'] : []),
          String(line.qty ?? 0),
          line.unit || '—',
          ...(showPrice ? [money(line.priceRub ?? 0)] : []),
          ...(showAmount ? [money(line.amountRub ?? 0)] : []),
        ];
        return `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
      })
      .join('');
    return `<table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  };

  const worksHtml = `${linesTable(current.freeWorks)}${
    showAmount
      ? `<div class="wo-print-works-footer" style="margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;font-size:13px;"><strong>Итог:</strong> ${escapeHtml(
          money(current.totalAmountRub || 0),
        )}</div>`
      : ''
  }`;

  // Бригада расписывается прямо в своей таблице: пятая колонка — пустая ячейка под роспись.
  // Отдельных слотов подписи на бригаду не заводим — их число заранее неизвестно, а
  // колонка растёт вместе с составом сама.
  const crewHtml = current.crew.length
    ? `<table class="wo-crew"><thead><tr><th>Сотрудник</th><th>Таб. №</th><th>КТУ</th>${
        showAmount ? '<th>Начислено</th>' : ''
      }<th>Подпись</th></tr></thead><tbody>${current.crew
        .map(
          (member) =>
            `<tr><td>${escapeHtml(crewMemberLabel(member, deps) || '—')}</td><td>${escapeHtml(
              crewMemberPersonnelNumber(member, deps),
            )}</td><td>${escapeHtml(String(member.ktu ?? 1))}</td>${
              showAmount ? `<td>${escapeHtml(money(member.payoutRub ?? 0))}</td>` : ''
            }<td class="wo-sign-cell"></td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<div class="muted">Нет данных</div>`;

  const signaturesHtml = buildSignaturesHtml(current, deps, fs);

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
  const metaHtml = `<table class="wo-meta">${metaTier(tier1)}${metaTier(tier2)}</table>`;

  return {
    title: headerTitle,
    subtitle: printDate ? `Дата: ${formatMoscowDate(printDate)}` : 'Дата: —',
    extraCss: [
      ...baseExtraCss(fs),
      // Ячейка под роспись бригадира/рабочего — пустая, но с гарантированной шириной и
      // высотой: иначе браузер схлопывает её в нитку и расписаться негде.
      `[data-print-section="crew"] table.wo-crew td.wo-sign-cell { min-width: 34mm; height: 9mm; }`,
    ].join(' '),
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
