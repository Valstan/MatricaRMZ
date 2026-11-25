import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Статус двигателя в договоре — из истории ремонта (промты КАРМАНА #133/#135).
 *
 * Сторож держит одно правило: страница договора зовёт доменное `engineStateLabel`, а не
 * ведёт свою копию подписей. По реестру глобальных модулей «где двигатель сейчас» —
 * шесть реализаций в домене и две копии в main; седьмая копия в договоре была бы тем же
 * классом, что объединение, которое решает владелец отдельной ниткой.
 */
const PAGE = readFileSync(fileURLToPath(new URL('./ContractDetailsPage.tsx', import.meta.url)), 'utf8').replace(
  /\r\n/g,
  '\n',
);

describe('статус двигателя в договоре', () => {
  it('подпись статуса считается доменным правилом, а не своей копией', () => {
    expect(PAGE).toContain('engineStateLabel');
    // Прежняя копия подписей по замороженным флагам карточки — её больше нет.
    expect(PAGE).not.toContain('STATUS_LABELS.status_rejected');
    expect(PAGE).not.toContain('STATUS_LABELS.status_customer_accepted');
    expect(PAGE).not.toContain('STATUS_LABELS');
  });

  it('обе таблицы договора берут одну и ту же подпись', () => {
    // Слоты секции и «Двигатели договора» — один источник, иначе оператор увидит в
    // одной карточке два разных слова об одном двигателе.
    const uses = PAGE.match(/currentEngineStatusLabel\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
  });
});
