import type { PpeIssueCard } from '@matricarmz/shared';

import { escapeHtml, formatMomentLabel, openPrintPreview, type PrintSection } from './printPreview.js';

/**
 * Печатная форма «Карточка выдачи СИЗ» — по образцу владельца:
 * 11 колонок (наименование, сертификат, выдано: дата/кол-во/% износа/подпись,
 * возвращено: дата/кол-во/% износа/подпись работника/подпись кладовщика).
 */
export function ppeIssueCardDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

export function buildPpeIssueCardHtml(card: PpeIssueCard): string {
  const body = card.lines
    .map((line) => {
      const fact = line.fact;
      const name = line.continued ? '' : escapeHtml(line.position.name);
      const certificate = line.continued ? '' : escapeHtml(line.position.certificate ?? '');
      const issuedAt = fact ? ppeIssueCardDate(fact.issuedAt) : '';
      const qty = fact ? String(fact.qty) : '';
      const wear = fact && fact.wearPercent != null ? String(fact.wearPercent) : '';
      const returnedAt = fact ? ppeIssueCardDate(fact.returnedAt) : '';
      const returnedQty = fact && fact.returnedAt ? String(fact.qty) : '';
      const returnedWear = fact && fact.returnedAt && fact.wearPercent != null ? String(fact.wearPercent) : '';
      return (
        `<tr><td style="text-align:left;">${name}</td>` +
        `<td style="text-align:left;">${certificate}</td>` +
        `<td style="text-align:left;">${issuedAt}</td>` +
        `<td style="text-align:right;">${qty}</td>` +
        `<td style="text-align:right;">${wear}</td>` +
        `<td></td>` +
        `<td style="text-align:left;">${returnedAt}</td>` +
        `<td style="text-align:right;">${returnedQty}</td>` +
        `<td style="text-align:right;">${returnedWear}</td>` +
        `<td></td><td></td></tr>`
      );
    })
    .join('');

  return (
    `<table><thead>` +
    `<tr><th colspan="2" style="text-align:left;">СИЗ</th>` +
    `<th colspan="4" style="text-align:left;">Выдано</th>` +
    `<th colspan="5" style="text-align:left;">Возвращено</th></tr>` +
    `<tr><th style="text-align:left;">Наименование СИЗ</th>` +
    `<th style="text-align:left;">№ сертификата соответствия</th>` +
    `<th style="text-align:left;">Дата</th>` +
    `<th style="text-align:right;">Кол-во</th>` +
    `<th style="text-align:right;">% износа</th>` +
    `<th style="text-align:left;">подпись в получении</th>` +
    `<th style="text-align:left;">Дата</th>` +
    `<th style="text-align:right;">Кол-во</th>` +
    `<th style="text-align:right;">% износа</th>` +
    `<th style="text-align:left;">Подпись работника о сдаче</th>` +
    `<th style="text-align:left;">Кладовщика в получении</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

/** Печать карточки выдачи: альбомный лист — 11 колонок в книжную не влезают. */
export function printPpeIssueCard(opts: { title: string; subtitle?: string; card: PpeIssueCard }): void {
  const sections: PrintSection[] = [
    {
      id: 'issue-card',
      title: 'Карточка выдачи СИЗ',
      html: buildPpeIssueCardHtml(opts.card),
    },
  ];
  openPrintPreview({
    title: opts.title,
    ...(opts.subtitle ? { subtitle: opts.subtitle } : {}),
    orientation: 'landscape',
    sections,
    printHeader: { title: opts.title, meta: `Напечатано: ${formatMomentLabel(new Date())}` },
  });
}
