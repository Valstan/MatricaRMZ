import type { EngineInventoryRow, RepairChecklistAnswers, ReplenishmentBranch, RepairFundInstancePayload } from '@matricarmz/shared';
import {
  computeCustomerClaim,
  computeInventoryShortage,
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
};

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

const COMMON_STYLES = `
  @page { size: A4; margin: 12mm; }
  body { font-family: "Times New Roman", "Liberation Serif", serif; margin: 0; color: #0b1220; }
  h1 { margin: 0 0 6px 0; font-size: 18px; text-transform: uppercase; letter-spacing: 0.2px; text-align: center; }
  .doc { padding: 12mm; }
  .meta { color: #111827; margin-bottom: 12px; font-size: 12px; line-height: 1.45; }
  .hdr-row { margin-bottom: 4px; }
  .hdr-label { font-weight: 700; }
  .doc-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  .doc-table th, .doc-table td { border: 1px solid #111827; padding: 6px 8px; font-size: 12px; vertical-align: top; }
  .doc-table th { background: #f3f4f6; font-weight: 700; text-align: center; }
  .doc-table td.num { text-align: right; }
  .doc-table td.ctr { text-align: center; }
  .muted { color: #6b7280; }
  .sigs { margin-top: 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .sig { font-size: 12px; }
  .sig-label { font-weight: 700; margin-bottom: 4px; }
  .sig-row { margin-bottom: 3px; }
  .sig-key { color: #334155; }
  .sig-line { display: inline-block; border-bottom: 1px solid #111827; min-width: 200px; height: 14px; vertical-align: bottom; padding: 0 4px; }
  .footer { margin-top: 16px; color: #6b7280; font-size: 10px; text-align: right; }
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
  const title = 'Акт комплектности двигателя';
  const arrivalDate = getDate(ctx.answers, 'arrival_date');
  const inspectionDate = getDate(ctx.answers, 'completeness_inspection_date');
  const contractNumber = (ctx.contractNumber || getText(ctx.answers, 'contract_number')).trim();
  const brand = ctx.engineBrand || getText(ctx.answers, 'engine_brand');
  const number = ctx.engineNumber || getText(ctx.answers, 'engine_number');

  // Т6: комиссия из трёх — ФИО и в шапке («Комиссия в составе…»), и в подписях.
  const commission = [
    { role: 'начальник цеха', sig: getSignature(ctx.answers, 'commission_workshop_head'), label: 'Начальник цеха' },
    { role: 'мастер цеха', sig: getSignature(ctx.answers, 'commission_workshop_master'), label: 'Мастер цеха' },
    { role: 'начальник ОТК', sig: getSignature(ctx.answers, 'commission_otk_head'), label: 'Начальник ОТК' },
  ];
  const fioOrBlank = (fio: string) => (fio.trim() ? escapeHtml(fio.trim()) : '________________');
  const commissionText = `Комиссия в составе: ${commission
    .map((m) => `${m.role} ${fioOrBlank(m.sig.fio)}`)
    .join(', ')} произвели проверку комплектности внешним осмотром двигателя ${escapeHtml(brand)} ${escapeHtml(number)}`;

  // Договор — необязательное поле (контракта может ещё не быть): строка печатается только при наличии.
  const header = `
    ${contractNumber ? renderHeaderRow('Номер договора', contractNumber) : ''}
    <div class="hdr-row" style="margin-top:6px">${commissionText}</div>
    ${renderHeaderRow('Дата приёмки', dateOrFillIn(arrivalDate))}
  `;

  // Решение владельца (2026-06-12): «№ сборочной единицы» = артикул; «№ на детали» = набитый
  // номер; колонки «№ детали по чертежу» нет — это и есть № сборочной единицы.
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

  const tableBody = ctx.rows.length === 0
    ? `<tbody><tr><td colspan="6" class="muted ctr">Нет данных</td></tr></tbody>`
    : `<tbody>${ctx.rows
        .map(
          (r) => `<tr>
            <td>${escapeHtml(r.part_name)}</td>
            <td>${escapeHtml(r.assembly_unit_number)}</td>
            <td>${escapeHtml(String(r.stamped_number ?? ''))}</td>
            <td class="num">${escapeHtml(r.quantity)}</td>
            <td class="ctr">${escapeHtml(boolOrBlank(r.present))}</td>
            <td class="num">${escapeHtml(r.present ? String(r.actual_qty) : qtyOrBlank(r.actual_qty))}</td>
          </tr>`,
        )
        .join('')}</tbody>`;

  const signatures = `
    <div class="sigs">
      ${commission.map((m) => renderSignature(m.label, m.sig)).join('')}
      ${renderSignature('Утверждаю: директор по качеству', getSignature(ctx.answers, 'approved_by'))}
    </div>
    <div class="meta" style="margin-top:14px">${renderHeaderRow('Дата осмотра', dateOrFillIn(inspectionDate))}</div>`;

  const bodyHtml = `
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${header}</div>
    <table class="doc-table">${tableHead}${tableBody}</table>
    ${signatures}
    <div class="footer">Сформировано ${escapeHtml(formatMoscowDateTime(Date.now()))}</div>
  `;

  return wrapHtml({ title, bodyHtml });
}

export function buildInventoryDefectHtml(ctx: EngineInventoryPrintContext): string {
  const title = 'Акт дефектовки двигателя';
  const startDate = getDate(ctx.answers, 'defect_start_date');
  const endDate = getDate(ctx.answers, 'defect_end_date');
  const contractNumber = (ctx.contractNumber || getText(ctx.answers, 'contract_number')).trim();
  const dismantledNames = getEmployees(ctx.answers, 'defect_dismantled_by')
    .map((e) => e.fio)
    .filter(Boolean)
    .join('; ');

  const header = `
    ${contractNumber ? renderHeaderRow('Номер договора', contractNumber) : ''}
    ${renderHeaderRow('Марка двигателя', ctx.engineBrand || getText(ctx.answers, 'engine_brand'))}
    ${renderHeaderRow('№ двигателя', ctx.engineNumber || getText(ctx.answers, 'engine_number'))}
    ${renderHeaderRow('Разборку двигателя произвёл', dismantledNames || '____________________')}
    ${renderHeaderRow('Дата начала дефектовки', dateOrFillIn(startDate))}
    ${renderHeaderRow('Дата окончания дефектовки', dateOrFillIn(endDate))}
  `;

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

  const tableBody = ctx.rows.length === 0
    ? `<tbody><tr><td colspan="8" class="muted ctr">Нет данных</td></tr></tbody>`
    : `<tbody>${ctx.rows
        .map(
          (r) => `<tr>
            <td>${escapeHtml(r.part_name)}</td>
            <td>${escapeHtml(r.assembly_unit_number)}</td>
            <td>${escapeHtml(String(r.stamped_number ?? ''))}</td>
            <td class="num">${escapeHtml(r.quantity)}</td>
            <td class="num">${escapeHtml(qtyOrBlank(r.repairable_qty))}</td>
            <td class="num">${escapeHtml(qtyOrBlank(r.scrap_qty))}</td>
            <td class="num">${escapeHtml(qtyOrBlank(r.replace_qty))}</td>
            <td class="ctr">${escapeHtml(r.scrap_qty + r.replace_qty > 0 ? branchLabel(r.replenishment_branch) : '')}</td>
          </tr>`,
        )
        .join('')}</tbody>`;

  const signatures = `
    <div class="sigs">
      ${renderSignature('Дефектовку провёл', getSignature(ctx.answers, 'defect_signed_by'))}
      ${renderSignature('Утверждаю: директор по качеству', getSignature(ctx.answers, 'approved_by'))}
    </div>`;

  const bodyHtml = `
    <h1>${escapeHtml(title)}</h1>
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
