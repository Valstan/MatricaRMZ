import { escapeHtml, type PrintSection } from './printPreview.js';

// Служебная записка «запустить двигатели в работу» (план engine-payments-2026-07, этап 4).
// Один накопительный документ на несколько двигателей: бухгалтер отмечает галочками
// строки в карточке контракта → печать через стандартный редактируемый предпросмотр
// (секции отключаются чекбоксами). Текст-заготовка — дорабатывается владельцем отдельно.

export type ServiceMemoEngine = {
  engineNumber: string;
  brand: string;
  sectionToken: string;
  paidLabel: string;
  countdownLabel: string;
};

export function buildServiceMemoSections(args: {
  contractNumber: string;
  customerName: string;
  engines: ServiceMemoEngine[];
}): PrintSection[] {
  const { contractNumber, customerName, engines } = args;
  const intro = `
    <p>Директору</p>
    <p style="margin-top:14px">Прошу дать указание о запуске в ремонт следующих двигателей по контракту
    №&nbsp;${escapeHtml(contractNumber || '—')}${customerName ? ` (заказчик: ${escapeHtml(customerName)})` : ''}:
    по указанным двигателям получен авансовый платёж, срок ремонта (90 дней с даты аванса) подходит к завершению.</p>`;
  const rows = engines
    .map(
      (e, i) => `<tr>
        <td style="text-align:right">${i + 1}</td>
        <td>${escapeHtml(e.engineNumber || '—')}</td>
        <td>${escapeHtml(e.brand || '—')}</td>
        <td>${escapeHtml(e.sectionToken || '—')}</td>
        <td style="text-align:right">${escapeHtml(e.paidLabel)}</td>
        <td>${escapeHtml(e.countdownLabel)}</td>
      </tr>`,
    )
    .join('');
  const table = `<table>
    <thead><tr><th style="width:36px">№</th><th>Номер двигателя</th><th>Марка</th><th>Раздел контракта</th><th>Оплачено, ₽</th><th>Срок ремонта</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
  const footer = `
    <div style="margin-top:28px; display:flex; justify-content:space-between; gap:24px">
      <div>Дата: «____» ____________ 20___ г.</div>
      <div>Подпись: ____________________</div>
    </div>`;
  return [
    { id: 'memo-intro', title: 'Обращение', html: intro, hideTitle: true },
    { id: 'memo-table', title: `Двигатели (${engines.length})`, html: table, hideTitle: true },
    { id: 'memo-footer', title: 'Дата и подпись', html: footer, hideTitle: true },
  ];
}
