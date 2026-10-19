import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EnginesPage.tsx'), 'utf-8');

// Рекламации в отборах и статистике (P7, 19.10.2026): признак двигателя должен быть
// виден в списке сразу, а не только ступенью «Рекламация». Колонка читает готовое
// поле строки (`isReclamation` из listEngines) и сортируется по нему.
describe('EnginesPage — колонка «Рекламация»', () => {
  it('колонка заведена и читает готовое поле строки', () => {
    expect(PAGE).toContain("id: 'reclamation'");
    expect(PAGE).toContain("label: 'Рекламация'");
    expect(PAGE).toContain('e.isReclamation');
  });

  it('сортировка заведена на ключ состояния, а не на алфавит', () => {
    expect(PAGE).toContain("| 'reclamation'");
    expect(PAGE).toContain("case 'reclamation':");
    expect(PAGE).toContain("sortKey: 'reclamation'");
  });

  it('колонка видима по умолчанию — признак, который надо включать, не виден', () => {
    const hidden = /ENGINE_LIST_HIDDEN_BY_DEFAULT\s*=\s*\[(.*?)\]/s.exec(PAGE)?.[1] ?? '';
    expect(hidden, 'колонка «Рекламация» попала в скрытые по умолчанию').not.toContain("'reclamation'");
  });
});
