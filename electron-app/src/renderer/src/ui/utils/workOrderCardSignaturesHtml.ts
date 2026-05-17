import type { WorkOrderSignatureDecryptions } from '@matricarmz/shared';

import { escapeHtml } from './printPreview.js';

export const WORK_ORDER_SIGNATURE_LABELS = {
  crewMember: 'Подпись сотрудника участника бригады',
  workshopHead: 'Подпись начальника цеха',
  normingSpecialist: 'Подпись Специалист по нормированию',
  hrHead: 'Подпись начальник отдела кадров',
} as const;

export const WORK_ORDER_SIGNATURE_STYLES = `
.wo-sig{margin-top:24px;display:grid;gap:14px}
.wo-sig-row{display:grid;grid-template-columns:minmax(220px,42%) 1fr minmax(140px,24%);gap:12px;align-items:end}
.wo-sig-label{color:#334155;font-size:13px;line-height:1.3}
.wo-sig-line{border-bottom:1px solid #0f172a;min-height:18px}
.wo-sig-name{color:#0f172a;font-size:13px;white-space:nowrap;text-align:right}
@media print{.wo-sig{break-inside:avoid-page}}
`;

function signatureRow(label: string, decryption: string) {
  return [
    '<div class="wo-sig-row">',
    `<span class="wo-sig-label">${escapeHtml(label)}</span>`,
    '<span class="wo-sig-line"></span>',
    `<span class="wo-sig-name">${escapeHtml(decryption || '')}</span>`,
    '</div>',
  ].join('\n');
}

export function renderWorkOrderSignaturesHtml(decryptions: WorkOrderSignatureDecryptions): string {
  return [
    '<div class="wo-sig">',
    signatureRow(WORK_ORDER_SIGNATURE_LABELS.crewMember, decryptions.crewMember),
    signatureRow(WORK_ORDER_SIGNATURE_LABELS.workshopHead, decryptions.workshopHead),
    signatureRow(WORK_ORDER_SIGNATURE_LABELS.normingSpecialist, decryptions.normingSpecialist),
    signatureRow(WORK_ORDER_SIGNATURE_LABELS.hrHead, decryptions.hrHead),
    '</div>',
  ].join('\n');
}
