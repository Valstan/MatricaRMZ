import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PAGE = readFileSync(resolve(__dirname, './EngineDetailsPage.tsx'), 'utf-8');

describe('EngineDetailsPage — вкладка «Основное» (PR-I)', () => {
  it('есть поля даты отгрузки и приёмки заказчиком', () => {
    expect(PAGE).toContain('Дата отгрузки');
    expect(PAGE).toContain('Дата приёмки заказчиком');
    expect(PAGE).toContain("statusDateCode('status_customer_sent')");
    expect(PAGE).toContain("statusDateCode('status_customer_accepted')");
  });

  it('модуль движения деталей скрыт из «Основного»', () => {
    expect(PAGE).toContain('Модуль движения деталей скрыт');
  });

  it('даты из «Основного» создаются этапами при сохранении', () => {
    expect(PAGE).toContain("code: 'shipped'");
    expect(PAGE).toContain("code: 'accepted'");
    expect(PAGE).toContain('workSheets.stages');
  });

  it('этапы подтягиваются в «Основное», если дата пуста', () => {
    expect(PAGE).toContain('этапы → «Основное»');
  });
});
