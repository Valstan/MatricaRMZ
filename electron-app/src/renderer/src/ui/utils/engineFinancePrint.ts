import { formatKopMoney, type EngineFinanceSection, type EngineFinanceTotals } from '@matricarmz/shared';

import { escapeHtml, type PrintSection } from './printPreview.js';

// Печатная форма «Аудит по цене» (промты КАРМАНА #18/#19).
//
// Владелец вёл такую ведомость руками в Excel: по строке — двигатель, по столбцам —
// цена по договору, аванс, долг, состояние и итог по разделам. Здесь тот же смысл,
// но строки печатаются из данных программы: план (цена), платежи (аванс/доаванс/ок-расчёт)
// и карточка двигателя (номер, марка, состояние). Расхождение с ручной ведомостью
// видно сразу — и это главная ценность формы.

export type EngineFinancePrintArgs = {
  contractNumber: string;
  customerName: string;
  sections: readonly EngineFinanceSection[];
  totals: EngineFinanceTotals;
  /** Процент аванса, который показан расчётной колонкой. */
  advancePercent: number;
  /** Дата формирования (ISO). */
  dateIso: string;
};

function money(kop: number): string {
  return kop === 0 ? '—' : formatKopMoney(kop);
}

function moneyOrDash(kop: number | null): string {
  return kop == null ? '—' : formatKopMoney(kop);
}

function rowCells(row: {
  engineNumber: string;
  brandLabel: string;
  priceKop: number;
  priceFromPlan: boolean;
  plannedAdvanceKop: number;
  paidAdvanceKop: number;
  paidFinalKop: number;
  dueKop: number;
  vatKop: number | null;
  netKop: number | null;
  note: string;
  statusLabel: string;
  countdownLabel: string;
  emptySlot: boolean;
}): string {
  const number = row.engineNumber || (row.emptySlot ? '— (место свободно)' : '—');
  return `<tr>
    <td>${escapeHtml(number)}</td>
    <td>${escapeHtml(row.brandLabel || '—')}</td>
    <td style="text-align:right">${escapeHtml(money(row.priceKop))}${row.priceFromPlan ? ' <span style="color:#666">(по плану)</span>' : ''}</td>
    <td style="text-align:right">${escapeHtml(moneyOrDash(row.netKop))}</td>
    <td style="text-align:right">${escapeHtml(moneyOrDash(row.vatKop))}</td>
    <td style="text-align:right">${escapeHtml(money(row.plannedAdvanceKop))}</td>
    <td style="text-align:right">${escapeHtml(money(row.paidAdvanceKop))}</td>
    <td style="text-align:right">${escapeHtml(money(row.dueKop))}</td>
    <td style="text-align:right">${escapeHtml(money(row.paidFinalKop))}</td>
    <td>${escapeHtml(row.note || '—')}</td>
    <td>${escapeHtml(row.statusLabel || '—')}</td>
    <td>${escapeHtml(row.countdownLabel || '—')}</td>
  </tr>`;
}

function totalsRow(totals: EngineFinanceTotals, label: string): string {
  return `<tr style="font-weight:700">
    <td colspan="2" style="border-top:1px solid #333">${escapeHtml(label)}</td>
    <td style="text-align:right;border-top:1px solid #333">${escapeHtml(money(totals.priceKop))}</td>
    <td style="text-align:right;border-top:1px solid #333">${escapeHtml(moneyOrDash(totals.netKop))}</td>
    <td style="text-align:right;border-top:1px solid #333">${escapeHtml(moneyOrDash(totals.vatKop))}</td>
    <td style="text-align:right;border-top:1px solid #333">${escapeHtml(money(totals.plannedAdvanceKop))}</td>
    <td style="text-align:right;border-top:1px solid #333">${escapeHtml(money(totals.paidAdvanceKop))}</td>
    <td style="text-align:right;border-top:1px solid #333">${escapeHtml(money(totals.dueKop))}</td>
    <td style="text-align:right;border-top:1px solid #333">${escapeHtml(money(totals.paidFinalKop))}</td>
    <td colspan="3" style="border-top:1px solid #333"></td>
  </tr>`;
}

export function buildEngineFinancePrint(args: EngineFinancePrintArgs): PrintSection[] {
  const { contractNumber, customerName, sections, totals, advancePercent, dateIso } = args;
  const head = `<tr>
    <th style="width:32px">№</th>
    <th>Номер двигателя</th>
    <th>Модель</th>
    <th style="text-align:right">Цена по договору, ₽</th>
    <th style="text-align:right">Без НДС, ₽</th>
    <th style="text-align:right">НДС, ₽</th>
    <th style="text-align:right">Аванс ${advancePercent}%, ₽</th>
    <th style="text-align:right">Внесено авансов, ₽</th>
    <th style="text-align:right">Долг, ₽</th>
    <th style="text-align:right">Окончат. расчёт, ₽</th>
    <th>Примечание</th>
    <th>Состояние</th>
    <th>Отсчёт</th>
  </tr>`;

  const body = sections
    .map((section) => {
      const rows = section.rows
        .map((row, idx) => `<tr><td style="text-align:right">${idx + 1}</td>${rowCells(row)}</tr>`)
        .join('');
      return `<tr>
        <td colspan="12" style="font-weight:700;padding-top:10px">${escapeHtml(section.label)}</td>
      </tr>
      ${rows}
      ${totalsRow(section.totals, `Итого по разделу «${section.label}»:`)}`;
    })
    .join('');

  const table = `<table>
    <thead>${head}</thead>
    <tbody>${body}${totalsRow(totals, 'Итого по договору:')}</tbody>
  </table>`;

  const intro = `
    <p>Аудит по цене: оплата двигателей по договору</p>
    <p style="margin-top:10px">
      Контракт №&nbsp;${escapeHtml(contractNumber || '—')}${customerName ? ` (заказчик: ${escapeHtml(customerName)})` : ''}.
      Двигателей и мест: ${totals.count}. Сформировано ${escapeHtml(dateIso)}.
    </p>`;

  return [
    { id: 'finance-intro', title: 'Шапка', html: intro, hideTitle: true },
    { id: 'finance-table', title: 'Двигатели и деньги', html: table, hideTitle: true },
  ];
}
