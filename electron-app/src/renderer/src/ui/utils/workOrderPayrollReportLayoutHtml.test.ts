import { describe, expect, it } from 'vitest';

import { payrollSignaturesBlockHtml } from './workOrderPayrollReportLayoutHtml.js';

// The helper only reads report.payrollSignatures; a partial cast keeps the fixture small.
function report(payrollSignatures?: Record<string, string>) {
  return { ok: true, payrollSignatures } as any;
}

describe('payrollSignaturesBlockHtml', () => {
  it('renders the 4 signature labels', () => {
    const html = payrollSignaturesBlockHtml(report());
    expect(html).toContain('Подпись сотрудника участника бригады');
    expect(html).toContain('Подпись начальника цеха');
    expect(html).toContain('Подпись Специалист по нормированию');
    expect(html).toContain('Подпись начальник отдела кадров');
  });

  it('fills ФИО from payrollSignatures into the matching rows', () => {
    const html = payrollSignaturesBlockHtml(
      report({
        crewMember: 'Иванов И.И., Петров П.П.',
        workshopHead: 'Сидоров С.С.',
        normingSpecialist: 'Кузнецов К.К.',
        hrHead: 'Смирнов С.С.',
      }),
    );
    expect(html).toContain('Иванов И.И., Петров П.П.');
    expect(html).toContain('Сидоров С.С.');
    expect(html).toContain('Кузнецов К.К.');
    expect(html).toContain('Смирнов С.С.');
    // name sits inside the signature line
    expect(html).toContain('<span class="payroll-sig-name">Сидоров С.С.</span>');
  });

  it('renders empty signature lines (no name span) when signatures are absent', () => {
    const html = payrollSignaturesBlockHtml(report());
    expect(html).not.toContain('payroll-sig-name');
    expect(html).toContain('<span class="payroll-sig-line"></span>');
  });

  it('escapes HTML in resolved names', () => {
    const html = payrollSignaturesBlockHtml(report({ workshopHead: '<b>x</b>' }));
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });
});
