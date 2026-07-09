import type { EngineInventoryRow, RepairChecklistAnswers, ReplenishmentBranch, RepairFundInstancePayload } from '@matricarmz/shared';
import {
  computeCustomerClaim,
  computeInventoryShortage,
  ENGINE_RECEIPT_CONDITION_FIELDS,
  repairFundInstanceClassificationLabel,
  repairFundInstanceStatusLabel,
  selectRequirementInstances,
} from '@matricarmz/shared';

import { formatMoscowDate, formatMoscowDateTime } from './dateUtils.js';

export type EngineInventoryPrintContext = {
  engineBrand: string;
  engineNumber: string;
  contractNumber: string;
  rows: EngineInventoryRow[];
  answers: RepairChecklistAnswers;
  /** Цех двигателя — печатается в шапке акта («Цех: …»). */
  workshopName?: string;
  /** Версия акта (номер акта = № двигателя + версия): «Акт … № <engineNumber> (в. N)». */
  actVersion?: number;
  /** Пустой бланк для заполнения комиссией на месте: значения-клетки пустые + запасные строки. */
  blank?: boolean;
};

/** Сколько запасных пустых строк добавлять в конец таблицы «пустого бланка» под дозапись от руки. */
const BLANK_SPARE_ROWS = 6;

function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getText(answers: RepairChecklistAnswers, id: string): string {
  const a = (answers as any)[id];
  return a?.kind === 'text' ? String(a.value ?? '') : '';
}

function getDate(answers: RepairChecklistAnswers, id: string): number | null {
  const a = (answers as any)[id];
  return a?.kind === 'date' && Number.isFinite(a.value) ? Number(a.value) : null;
}

function getSignature(
  answers: RepairChecklistAnswers,
  id: string,
): { fio: string; position: string; signedAt: number | null } {
  const a = (answers as any)[id];
  if (a?.kind !== 'signature') return { fio: '', position: '', signedAt: null };
  return {
    fio: String(a.fio ?? ''),
    position: String(a.position ?? ''),
    signedAt: Number.isFinite(a.signedAt) ? Number(a.signedAt) : null,
  };
}

function getEmployees(answers: RepairChecklistAnswers, id: string): Array<{ employeeId: string; fio: string; position: string }> {
  const a = (answers as any)[id];
  if (a?.kind !== 'employees' || !Array.isArray(a.employees)) return [];
  return a.employees
    .map((e: any) => ({ employeeId: String(e?.employeeId ?? ''), fio: String(e?.fio ?? ''), position: String(e?.position ?? '') }))
    .filter((e: { fio: string }) => e.fio.trim().length > 0);
}

function renderHeaderRow(label: string, value: string): string {
  return `<div class="hdr-row"><span class="hdr-label">${escapeHtml(label)}:</span> <span class="hdr-value">${escapeHtml(
    value,
  )}</span></div>`;
}

function renderSignature(
  label: string,
  sig: { fio: string; position: string; signedAt: number | null },
): string {
  const date = sig.signedAt ? escapeHtml(formatMoscowDate(sig.signedAt)) : '';
  return `<div class="sig">
  <div class="sig-label">${escapeHtml(label)}</div>
  <div class="sig-row"><span class="sig-key">ФИО:</span> <span class="sig-line">${escapeHtml(sig.fio)}</span></div>
  <div class="sig-row"><span class="sig-key">Должность:</span> <span class="sig-line">${escapeHtml(sig.position)}</span></div>
  <div class="sig-row"><span class="sig-key">Подпись:</span> <span class="sig-line"></span></div>
  <div class="sig-row"><span class="sig-key">Дата:</span> <span class="sig-line">${date}</span></div>
</div>`;
}

// Компактная печать (запрос владельца): крупнее шрифт таблицы, минимальные отступы строк/полей,
// один отступ страницы (только @page, без двойного .doc padding) — больше строк на лист.
// Видная строка-идентификатор акта: «Акт <вид> № <№двигателя> (в. N) · от <дата> · Цех: …».
// Номер акта = номер двигателя + версия (решение владельца) — прямая связь с двигателем.
function renderActIdentity(opts: {
  actKind: string;
  engineNumber: string;
  version?: number;
  date: number | null;
  workshopName?: string;
}): string {
  const num = escapeHtml(opts.engineNumber.trim() || '—');
  const ver = opts.version && opts.version > 0 ? ` (в. ${opts.version})` : '';
  const date = opts.date ? escapeHtml(formatMoscowDate(opts.date)) : DATE_FILL_IN;
  const cex =
    opts.workshopName && opts.workshopName.trim()
      ? `<span class="sep">·</span>Цех: ${escapeHtml(opts.workshopName.trim())}`
      : '';
  return `<div class="act-id">Акт ${escapeHtml(opts.actKind)} № <span class="num">${num}${ver}</span><span class="sep">·</span>от ${date}${cex}</div>`;
}

// «Состояние при поступлении» на акте комплектности (Incoming Inspection): упаковка/пломбы/
// повреждения/следы вскрытия + особые отметки. В пустом бланке — прочерк-линии под запись от руки.
function renderReceiptCondition(answers: RepairChecklistAnswers, blank: boolean): string {
  const rows = ENGINE_RECEIPT_CONDITION_FIELDS.map((f) => {
    const val = blank ? '' : getText(answers, f.id).trim();
    return `<div class="hdr-row"><span class="hdr-label">${escapeHtml(f.label)}:</span> <span class="rc-line">${escapeHtml(val)}</span></div>`;
  }).join('');
  return `<div class="meta rc-block"><div class="rc-title">Состояние при поступлении</div>${rows}</div>`;
}

// Запасные пустые строки в конец «пустого бланка» — под дозапись деталей от руки.
function spareRows(colCount: number, n: number): string {
  const cells = Array.from({ length: colCount }, () => '<td>&nbsp;</td>').join('');
  return Array.from({ length: n }, () => `<tr class="spare">${cells}</tr>`).join('');
}

const COMMON_STYLES = `
  @page { size: A4; margin: 10mm; }
  body { font-family: "Times New Roman", "Liberation Serif", serif; margin: 0; color: #0b1220; font-size: 13px; line-height: 1.22; }
  h1 { margin: 0 0 2px 0; font-size: 17px; text-transform: uppercase; letter-spacing: 0.2px; text-align: center; }
  .doc { padding: 0; }
  .act-id { text-align: center; font-size: 14px; font-weight: 700; margin: 0 0 6px 0; padding: 3px 0; border-top: 2px solid #111827; border-bottom: 2px solid #111827; }
  .act-id .num { font-size: 16px; }
  .act-id .sep { font-weight: 400; color: #334155; margin: 0 6px; }
  .meta { color: #111827; margin-bottom: 6px; font-size: 12.5px; line-height: 1.2; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; row-gap: 0; }
  .hdr-row { margin-bottom: 1px; }
  .hdr-label { font-weight: 700; }
  .doc-table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  .doc-table th, .doc-table td { border: 1px solid #111827; padding: 1px 5px; font-size: 13px; vertical-align: top; }
  .doc-table th { background: #f3f4f6; font-weight: 700; text-align: center; font-size: 12px; line-height: 1.1; }
  .doc-table td.num { text-align: right; }
  .doc-table td.ctr { text-align: center; }
  .doc-table tr.spare td { height: 16px; }
  .muted { color: #6b7280; }
  .note { font-size: 11px; color: #334155; margin-top: 3px; font-style: italic; }
  .rc-block { border: 1px solid #111827; padding: 4px 8px; margin: 6px 0; }
  .rc-title { font-weight: 700; margin-bottom: 2px; }
  .rc-line { display: inline-block; border-bottom: 1px solid #94a3b8; min-width: 260px; vertical-align: bottom; }
  .sigs { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; column-gap: 18px; row-gap: 10px; }
  .sig { font-size: 12.5px; }
  .sig-label { font-weight: 700; margin-bottom: 2px; }
  .sig-row { margin-bottom: 2px; }
  .sig-key { color: #334155; }
  .sig-line { display: inline-block; border-bottom: 1px solid #111827; min-width: 180px; height: 13px; vertical-align: bottom; padding: 0 4px; }
  .footer { margin-top: 10px; color: #6b7280; font-size: 10px; text-align: right; }
  @media print { .no-print { display: none; } }
`;

function wrapHtml(opts: { title: string; bodyHtml: string }): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(opts.title)}</title>
  <style>${COMMON_STYLES}</style>
</head>
<body>
  <div class="no-print" style="margin:12px;">
    <button id="printBtn">Печать / PDF</button>
  </div>
  <div class="doc">
    ${opts.bodyHtml}
  </div>
  <script>
    var btn = document.getElementById('printBtn');
    if (btn) btn.addEventListener('click', function() { window.print(); });
  </script>
</body>
</html>`;
}

// Т6: поля, которые оператор заполняет руками с бумаги, печатаются ПУСТЫМИ,
// а не нулями/«нет» — иначе в распечатку неудобно вписывать.
function boolOrBlank(v: boolean): string {
  return v ? 'да' : '';
}

function qtyOrBlank(n: number): string {
  return n > 0 ? String(n) : '';
}

// Т6: незаполненная дата на печатном акте — прочерк-бланк для вписывания от руки,
// а не пустая строка «Дата: » без значения.
const DATE_FILL_IN = '«____» ____________ 20___ г.';
function dateOrFillIn(d: number | null): string {
  return d ? formatMoscowDate(d) : DATE_FILL_IN;
}

function branchLabel(branch: ReplenishmentBranch | null): string {
  if (branch === 'customer') return 'Заказчик';
  if (branch === 'repair') return 'Свой ремонт';
  if (branch === 'purchase') return 'Закупка';
  return '—';
}

export function buildInventoryActHtml(ctx: EngineInventoryPrintContext): string {
  const blank = ctx.blank === true;
  const title = blank ? 'Акт комплектности двигателя (бланк)' : 'Акт комплектности двигателя';
  const arrivalDate = getDate(ctx.answers, 'arrival_date');
  const inspectionDate = getDate(ctx.answers, 'completeness_inspection_date');
  const contractNumber = (ctx.contractNumber || getText(ctx.answers, 'contract_number')).trim();
  const brand = ctx.engineBrand || getText(ctx.answers, 'engine_brand');
  const number = ctx.engineNumber || getText(ctx.answers, 'engine_number');

  const commission = [
    { sig: getSignature(ctx.answers, 'commission_workshop_head'), label: 'Комиссия: начальник цеха' },
    { sig: getSignature(ctx.answers, 'commission_workshop_master'), label: 'Комиссия: мастер цеха' },
    { sig: getSignature(ctx.answers, 'commission_otk_head'), label: 'Комиссия: начальник ОТК' },
  ];
  const acceptance = getSignature(ctx.answers, 'acceptance_signed_by');
  const customerRep = getSignature(ctx.answers, 'customer_representative');
  const approved = getSignature(ctx.answers, 'approved_by');

  const identity = renderActIdentity({
    actKind: 'комплектности',
    engineNumber: number,
    ...(ctx.actVersion ? { version: ctx.actVersion } : {}),
    date: arrivalDate,
    ...(ctx.workshopName ? { workshopName: ctx.workshopName } : {}),
  });

  const header = `
    <div class="meta-grid">
      ${renderHeaderRow('Марка двигателя', brand || '—')}
      ${renderHeaderRow('№ двигателя', number || '—')}
      ${renderHeaderRow('Договор / заказчик', contractNumber || '')}
      ${renderHeaderRow('Дата приёмки', dateOrFillIn(arrivalDate))}
    </div>`;

  // Решение владельца (2026-06-12): «№ сборочной единицы» = артикул; «№ на детали» = набитый номер.
  const tableHead = `
    <thead>
      <tr>
        <th style="width:34%">Наименование детали (узла)</th>
        <th style="width:18%">№ сборочной единицы</th>
        <th style="width:14%">№ на детали</th>
        <th style="width:10%">План</th>
        <th style="width:10%">Наличие</th>
        <th style="width:14%">Фактически принято</th>
      </tr>
    </thead>`;

  const dataRows = ctx.rows
    .map(
      (r) => `<tr>
            <td>${escapeHtml(r.part_name)}</td>
            <td>${escapeHtml(r.assembly_unit_number)}</td>
            <td>${blank ? '' : escapeHtml(String(r.stamped_number ?? ''))}</td>
            <td class="num">${escapeHtml(r.quantity)}</td>
            <td class="ctr">${blank ? '' : escapeHtml(boolOrBlank(r.present))}</td>
            <td class="num">${blank ? '' : escapeHtml(r.present ? String(r.actual_qty) : qtyOrBlank(r.actual_qty))}</td>
          </tr>`,
    )
    .join('');
  const tableBody =
    ctx.rows.length === 0 && !blank
      ? `<tbody><tr><td colspan="6" class="muted ctr">Нет данных</td></tr></tbody>`
      : `<tbody>${dataRows}${blank ? spareRows(6, BLANK_SPARE_ROWS) : ''}</tbody>`;

  const signatures = `
    <div class="sigs">
      ${renderSignature('Приёмку провёл', acceptance)}
      ${commission.map((m) => renderSignature(m.label, m.sig)).join('')}
      ${renderSignature('Представитель заказчика', customerRep)}
      ${renderSignature('Утверждаю: директор по качеству', approved)}
    </div>
    <div class="meta" style="margin-top:8px">${renderHeaderRow('Дата осмотра', dateOrFillIn(inspectionDate))}</div>
    <div class="note">Комплектность указана по факту поступления. Окончательная комплектность определяется после разборки и дефектовки.</div>`;

  const bodyHtml = `
    <h1>${escapeHtml(title)}</h1>
    ${identity}
    <div class="meta">${header}</div>
    ${renderReceiptCondition(ctx.answers, blank)}
    <table class="doc-table">${tableHead}${tableBody}</table>
    ${signatures}
    <div class="footer">Сформировано ${escapeHtml(formatMoscowDateTime(Date.now()))}</div>
  `;

  return wrapHtml({ title, bodyHtml });
}

export function buildInventoryDefectHtml(ctx: EngineInventoryPrintContext): string {
  const blank = ctx.blank === true;
  const title = blank ? 'Акт дефектовки двигателя (бланк)' : 'Акт дефектовки двигателя';
  const startDate = getDate(ctx.answers, 'defect_start_date');
  const endDate = getDate(ctx.answers, 'defect_end_date');
  const contractNumber = (ctx.contractNumber || getText(ctx.answers, 'contract_number')).trim();
  const brand = ctx.engineBrand || getText(ctx.answers, 'engine_brand');
  const number = ctx.engineNumber || getText(ctx.answers, 'engine_number');
  const dismantledNames = blank
    ? ''
    : getEmployees(ctx.answers, 'defect_dismantled_by')
        .map((e) => e.fio)
        .filter(Boolean)
        .join('; ');

  const identity = renderActIdentity({
    actKind: 'дефектовки',
    engineNumber: number,
    ...(ctx.actVersion ? { version: ctx.actVersion } : {}),
    date: startDate,
    ...(ctx.workshopName ? { workshopName: ctx.workshopName } : {}),
  });

  const header = `
    <div class="meta-grid">
      ${renderHeaderRow('Марка двигателя', brand || '—')}
      ${renderHeaderRow('№ двигателя', number || '—')}
      ${renderHeaderRow('Договор / заказчик', contractNumber || '')}
      ${renderHeaderRow('Разборку двигателя произвёл', dismantledNames || '____________________')}
      ${renderHeaderRow('Дата начала дефектовки', dateOrFillIn(startDate))}
      ${renderHeaderRow('Дата окончания дефектовки', dateOrFillIn(endDate))}
    </div>`;

  // Решение владельца (2026-06-12): колонки те же, что в акте комплектности —
  // «№ сборочной единицы» (артикул) + «№ на детали» (набитый), без «№ детали по чертежу».
  const tableHead = `
    <thead>
      <tr>
        <th style="width:24%">Наименование детали (узла)</th>
        <th style="width:14%">№ сборочной единицы</th>
        <th style="width:12%">№ на детали</th>
        <th style="width:8%">Кол-во</th>
        <th style="width:12%">Ремонтопригодная</th>
        <th style="width:9%">Утиль</th>
        <th style="width:11%">Заменить новой</th>
        <th style="width:10%">Восполнение</th>
      </tr>
    </thead>`;

  const dataRows = ctx.rows
    .map(
      (r) => `<tr>
            <td>${escapeHtml(r.part_name)}</td>
            <td>${escapeHtml(r.assembly_unit_number)}</td>
            <td>${blank ? '' : escapeHtml(String(r.stamped_number ?? ''))}</td>
            <td class="num">${escapeHtml(r.quantity)}</td>
            <td class="num">${blank ? '' : escapeHtml(qtyOrBlank(r.repairable_qty))}</td>
            <td class="num">${blank ? '' : escapeHtml(qtyOrBlank(r.scrap_qty))}</td>
            <td class="num">${blank ? '' : escapeHtml(qtyOrBlank(r.replace_qty))}</td>
            <td class="ctr">${blank ? '' : escapeHtml(r.scrap_qty + r.replace_qty > 0 ? branchLabel(r.replenishment_branch) : '')}</td>
          </tr>`,
    )
    .join('');
  const tableBody =
    ctx.rows.length === 0 && !blank
      ? `<tbody><tr><td colspan="8" class="muted ctr">Нет данных</td></tr></tbody>`
      : `<tbody>${dataRows}${blank ? spareRows(8, BLANK_SPARE_ROWS) : ''}</tbody>`;

  const signatures = `
    <div class="sigs">
      ${renderSignature('Дефектовку провёл', getSignature(ctx.answers, 'defect_signed_by'))}
      ${renderSignature('Утверждаю: директор по качеству', getSignature(ctx.answers, 'approved_by'))}
    </div>
    <div class="note">Годно / ремонтопригодно — оставляем; утиль — в лом; заменить новой — заказать. Восполнение: за чей счёт закрывается позиция.</div>`;

  const bodyHtml = `
    <h1>${escapeHtml(title)}</h1>
    ${identity}
    <div class="meta">${header}</div>
    <table class="doc-table">${tableHead}${tableBody}</table>
    ${signatures}
    <div class="footer">Сформировано ${escapeHtml(formatMoscowDateTime(Date.now()))}</div>
  `;

  return wrapHtml({ title, bodyHtml });
}

/**
 * Ф4: Акт претензии заказчику. Секция 1 — дефектные детали на ветке восполнения «заказчик»
 * (утиль + заменить); секция 2 — недостача комплектности при приёмке. Обе секции считаются
 * из переданных строк (повторная печать исторической версии работает на замороженном снимке).
 */
export function buildInventoryClaimHtml(ctx: EngineInventoryPrintContext): string {
  const title = 'Акт претензии заказчику';
  const arrivalDate = getDate(ctx.answers, 'arrival_date');
  const claim = computeCustomerClaim(ctx.rows);
  const shortage = computeInventoryShortage(ctx.rows);
  const contractNumber = (ctx.contractNumber || getText(ctx.answers, 'contract_number')).trim();

  const header = `
    ${contractNumber ? renderHeaderRow('Номер договора', contractNumber) : ''}
    ${renderHeaderRow('Марка двигателя', ctx.engineBrand || getText(ctx.answers, 'engine_brand'))}
    ${renderHeaderRow('№ двигателя', ctx.engineNumber || getText(ctx.answers, 'engine_number'))}
    ${renderHeaderRow('Дата приёмки', dateOrFillIn(arrivalDate))}
  `;

  // Те же правила колонок, что в актах комплектности/дефектовки: «№ сборочной единицы» = артикул,
  // «№ детали по чертежу» не печатается.
  const claimHead = `
    <thead>
      <tr>
        <th style="width:36%">Наименование детали (узла)</th>
        <th style="width:18%">№ сборочной единицы</th>
        <th style="width:11%">Кол-во</th>
        <th style="width:11%">Утиль</th>
        <th style="width:12%">Заменить новой</th>
        <th style="width:12%">К восполнению</th>
      </tr>
    </thead>`;
  const claimBody = claim.items.length === 0
    ? `<tbody><tr><td colspan="6" class="muted ctr">Нет позиций</td></tr></tbody>`
    : `<tbody>${claim.items
        .map(
          (it) => `<tr>
            <td>${escapeHtml(it.part_name)}</td>
            <td>${escapeHtml(it.assembly_unit_number)}</td>
            <td class="num">${escapeHtml(it.quantity)}</td>
            <td class="num">${escapeHtml(it.scrap_qty)}</td>
            <td class="num">${escapeHtml(it.replace_qty)}</td>
            <td class="num">${escapeHtml(it.claim_qty)}</td>
          </tr>`,
        )
        .join('')}</tbody>`;

  const shortageHead = `
    <thead>
      <tr>
        <th style="width:38%">Наименование детали (узла)</th>
        <th style="width:20%">№ сборочной единицы</th>
        <th style="width:14%">План</th>
        <th style="width:14%">Принято</th>
        <th style="width:14%">Недостаёт</th>
      </tr>
    </thead>`;
  const shortageBody = shortage.items.length === 0
    ? `<tbody><tr><td colspan="5" class="muted ctr">Недостачи нет</td></tr></tbody>`
    : `<tbody>${shortage.items
        .map(
          (it) => `<tr>
            <td>${escapeHtml(it.part_name)}</td>
            <td>${escapeHtml(it.assembly_unit_number)}</td>
            <td class="num">${escapeHtml(it.quantity)}</td>
            <td class="num">${escapeHtml(it.actual_qty)}</td>
            <td class="num">${escapeHtml(it.missing)}</td>
          </tr>`,
        )
        .join('')}</tbody>`;

  const totals = `
    <div class="meta" style="margin-top:10px">
      ${renderHeaderRow('Дефектных позиций к восполнению заказчиком', `${claim.total} (${claim.claimUnits} ед.)`)}
      ${renderHeaderRow('Позиций недостачи при приёмке', `${shortage.total} (${shortage.missingUnits} ед.)`)}
    </div>`;

  const signatures = `
    <div class="sigs">
      ${renderSignature('Претензию составил', getSignature(ctx.answers, 'claim_signed_by'))}
      ${renderSignature('Утверждаю: директор по качеству', getSignature(ctx.answers, 'approved_by'))}
    </div>`;

  const bodyHtml = `
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${header}</div>
    <div class="meta" style="margin-top:12px"><strong>1. Дефектные детали, восполнение — за заказчиком</strong></div>
    <table class="doc-table">${claimHead}${claimBody}</table>
    <div class="meta" style="margin-top:12px"><strong>2. Недостача комплектности при приёмке</strong></div>
    <table class="doc-table">${shortageHead}${shortageBody}</table>
    ${totals}
    ${signatures}
    <div class="footer">Сформировано ${escapeHtml(formatMoscowDateTime(Date.now()))}</div>
  `;

  return wrapHtml({ title, bodyHtml });
}

export type EngineRequirementPrintContext = {
  engineBrand: string;
  engineNumber: string;
  contractNumber: string;
  instances: RepairFundInstancePayload[];
  printedAt?: number;
};

/**
 * Ремфонд Ф4: «Требование к заказчику» — обоснование роста цены ремонта. Перечень
 * деталей двигателя с личными (набитыми) номерами, классифицированных в утиль/замену
 * (мы вывели их из двигателя и восполнили). Без сумм — денежную часть бухгалтерия
 * считает отдельно (решение владельца). Печать работает на замороженном снимке.
 */
export function buildEngineRequirementHtml(ctx: EngineRequirementPrintContext): string {
  const title = 'Требование к заказчику';
  const printedAt = ctx.printedAt && Number.isFinite(ctx.printedAt) ? Number(ctx.printedAt) : Date.now();
  const items = selectRequirementInstances(ctx.instances);

  const header = `
    ${ctx.contractNumber.trim() ? renderHeaderRow('Номер договора', ctx.contractNumber) : ''}
    ${renderHeaderRow('Марка двигателя', ctx.engineBrand)}
    ${renderHeaderRow('№ двигателя', ctx.engineNumber)}
    ${renderHeaderRow('Дата формирования', formatMoscowDate(printedAt))}
  `;

  const tableHead = `
    <thead>
      <tr>
        <th style="width:18%">Личный № детали</th>
        <th style="width:40%">Наименование детали (узла)</th>
        <th style="width:16%">Классификация</th>
        <th style="width:14%">Дата фиксации</th>
        <th style="width:12%">Статус</th>
      </tr>
    </thead>`;
  const tableBody =
    items.length === 0
      ? `<tbody><tr><td colspan="5" class="muted ctr">Нет деталей в утиль/замену</td></tr></tbody>`
      : `<tbody>${items
          .map(
            (it) => `<tr>
            <td>${escapeHtml(it.stampedNumber)}</td>
            <td>${escapeHtml(it.partLabel)}</td>
            <td class="ctr">${escapeHtml(repairFundInstanceClassificationLabel(it.classification))}</td>
            <td class="ctr">${escapeHtml(it.capturedAt ? formatMoscowDate(it.capturedAt) : '')}</td>
            <td class="ctr">${escapeHtml(repairFundInstanceStatusLabel(it.status))}</td>
          </tr>`,
          )
          .join('')}</tbody>`;

  const intro = `
    <div class="meta" style="margin-top:12px">
      Перечисленные ниже детали двигателя имеют индивидуальные (набитые) номера и при дефектовке
      классифицированы как <strong>утиль</strong> либо <strong>замена</strong>. Восполнение этих
      позиций выполнено за счёт исполнителя ремонта, что является основанием для пересмотра
      стоимости ремонта двигателя.
    </div>`;

  const totals = `
    <div class="meta" style="margin-top:10px">
      ${renderHeaderRow('Позиций к восполнению (утиль/замена)', String(items.length))}
    </div>`;

  const blank = { fio: '', position: '', signedAt: null };
  const signatures = `
    <div class="sigs">
      ${renderSignature('Требование составил', blank)}
      ${renderSignature('Утверждаю: руководитель', blank)}
    </div>`;

  const bodyHtml = `
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${header}</div>
    ${intro}
    <table class="doc-table">${tableHead}${tableBody}</table>
    ${totals}
    ${signatures}
    <div class="footer">Сформировано ${escapeHtml(formatMoscowDateTime(printedAt))}</div>
  `;
  return wrapHtml({ title, bodyHtml });
}

export function openEngineInventoryPrintWindow(html: string): void {
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => {
    const btn = w.document.getElementById('printBtn');
    if (btn) btn.addEventListener('click', () => w.print());
    w.focus();
  }, 200);
}
