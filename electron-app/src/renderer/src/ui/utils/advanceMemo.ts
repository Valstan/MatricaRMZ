import { escapeHtml, type PrintSection } from './printPreview.js';

// Печатная форма «Авансы по договору» (владелец 13.11.2026): показать директору, по каким
// двигателям внесён авансовый платёж, сколько и когда. Форма — по образцу служебной
// записки (serviceMemo.ts): бухгалтер отмечает галочками двигатели в карточке контракта →
// печать через стандартный редактируемый предпросмотр.

export type AdvanceMemoRow = {
  engineNumber: string;
  brand: string;
  sectionToken: string;
  /** Аванс по двигателю, ₽. */
  advanceLabel: string;
  /** Дата аванса (пусто — аванса не было). */
  advanceDateLabel: string;
  /** Стоимость двигателя по контракту, ₽ — для сверки процента. */
  priceLabel: string;
};

export function buildAdvanceMemoSections(args: {
  contractNumber: string;
  customerName: string;
  rows: AdvanceMemoRow[];
  /** Итог авансов по форме, ₽. */
  totalLabel: string;
  /** Дата платежа, если она одна на всю форму. */
  paymentDateLabel?: string;
}): PrintSection[] {
  const { contractNumber, customerName, rows, totalLabel, paymentDateLabel } = args;
  const intro = `
    <p>Директору</p>
    <p style="margin-top:14px">По контракту №&nbsp;${escapeHtml(contractNumber || '—')}${
      customerName ? ` (заказчик: ${escapeHtml(customerName)})` : ''
    } получены авансовые платежи по следующим двигателям:${
      paymentDateLabel ? ` дата платежа — ${escapeHtml(paymentDateLabel)}` : ''
    }</p>`;
  const body = rows
    .map(
      (e, i) => `<tr>
        <td style="text-align:right">${i + 1}</td>
        <td>${escapeHtml(e.engineNumber || '—')}</td>
        <td>${escapeHtml(e.brand || '—')}</td>
        <td>${escapeHtml(e.sectionToken || '—')}</td>
        <td style="text-align:right">${escapeHtml(e.advanceLabel)}</td>
        <td>${escapeHtml(e.advanceDateLabel || '—')}</td>
        <td style="text-align:right">${escapeHtml(e.priceLabel)}</td>
      </tr>`,
    )
    .join('');
  const table = `<table>
    <thead><tr><th style="width:36px">№</th><th>Номер двигателя</th><th>Марка</th><th>Раздел контракта</th><th style="text-align:right">Аванс, ₽</th><th>Дата аванса</th><th style="text-align:right">Стоимость по контракту, ₽</th></tr></thead>
    <tbody>${body}
      <tr>
        <td colspan="4" style="text-align:right;font-weight:700;border-top:1px solid #333">Итого авансов:</td>
        <td style="text-align:right;font-weight:700;border-top:1px solid #333">${escapeHtml(totalLabel)}</td>
        <td colspan="2" style="border-top:1px solid #333"></td>
      </tr>
    </tbody>
  </table>`;
  const footer = `
    <div style="margin-top:28px; display:flex; justify-content:space-between; gap:24px">
      <div>Дата: «____» ____________ 20___ г.</div>
      <div>Подпись: ____________________</div>
    </div>`;
  return [
    { id: 'advance-intro', title: 'Обращение', html: intro, hideTitle: true },
    { id: 'advance-table', title: `Двигатели (${rows.length})`, html: table, hideTitle: true },
    { id: 'advance-footer', title: 'Дата и подпись', html: footer, hideTitle: true },
  ];
}
