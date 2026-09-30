import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Авторство наряда в шапке карточки (H1): создатель — навсегда из auditTrail,
// изменивший — последняя запись. Данные уже пишутся при каждом сохранении,
// здесь сторожим, что шапка их показывает, а не теряет молча.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const CARD = src('./WorkOrderDetailsPage.tsx');

describe('авторство наряда в шапке карточки (H1)', () => {
  it('шапка считает авторство из auditTrail и показывает «создал / изменил»', () => {
    expect(CARD).toContain('workOrderAuthorship(payload.auditTrail)');
    expect(CARD).toContain('· создал ');
    expect(CARD).toContain('{a.createdBy}');
    expect(CARD).toContain('· изменил ');
    expect(CARD).toContain('{a.updatedBy}');
  });

  it('авторство считается чистой функцией в shared (переиспользуемо карточками)', () => {
    expect(CARD).toContain('workOrderAuthorship,');
  });
});
