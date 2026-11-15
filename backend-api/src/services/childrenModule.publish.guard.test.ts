import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Запись идёт серверной дверью, а клиент читает pull-only реплику. Если строка ждёт
// тика публикатора (раз в минуту), оператор после выдачи подарка видит пустой журнал:
// «я вручил, а его нет». Поэтому дверь публикует строку в журнал СРАЗУ, а публикатор
// лишь подчищает то, что не доехало.

const SERVICE = fileURLToPath(new URL('./childrenService.ts', import.meta.url));
const ORG_SERVICE = fileURLToPath(new URL('./organizationService.ts', import.meta.url));
const PUBLISHER = fileURLToPath(new URL('./sync/childrenSyncPublisherService.ts', import.meta.url));

function src(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('публикация записи без ожидания тика', () => {
  it('публикатор умеет публиковать одну строку сразу', () => {
    const text = src(PUBLISHER);
    expect(text).toContain('export async function publishOrganizationRowNow');
    expect(text).toContain('allowSyncConflicts: true');
  });

  it('дверь ребёнка публикует строку сразу и с актором', () => {
    const text = src(SERVICE);
    expect(text).toContain('publishOrganizationRowNow(toChildInput(');
    expect(text).toMatch(/createChild\([^)]*actor\?/);
    expect(text).toMatch(/updateChild\([^)]*actor\?/);
    expect(text).toMatch(/deleteChild\([^)]*actor\?/);
  });

  it('дверь мероприятия и выдачи публикует строку сразу', () => {
    const text = src(ORG_SERVICE);
    expect(text).toContain('publishOrganizationRowNow(toOrgEventInput(');
    expect(text).toContain('publishOrganizationRowNow(toGiftRecordInput(');
    expect(text).toMatch(/createOrgEvent\([^)]*actor\?/);
    expect(text).toMatch(/createGiftRecord\([^)]*actor\?/);
  });
});
