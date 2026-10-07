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

  it('даты из «Основного» пишутся этапами — теперь в main (дефект 07.10.2026)', () => {
    // Прежде здесь искали `code: 'shipped'` в странице: рендерер звал
    // `workSheets:stages:save` под поимённым `work_sheets.edit` — у ролей без него
    // этап молча не появлялся. Запись переехала в `engines:card:save` (main);
    // сторож места — `repairStageFunnel.guard.test.ts`. Здесь держим обратное:
    // рендерер этапы не пишет (save/ensure — не его дверь).
    expect(PAGE).not.toContain('workSheets.stages\n');
    expect(PAGE).not.toMatch(/workSheets\.stages\s*\.\s*save/);
    expect(PAGE).not.toContain("code: 'shipped'");
    expect(PAGE).not.toContain("code: 'accepted'");
  });

  it('этапы подтягиваются в «Основное», если дата пуста', () => {
    expect(PAGE).toContain('этапы → «Основное»');
  });
});
