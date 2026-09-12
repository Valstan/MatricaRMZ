import { describe, expect, it } from 'vitest';

import { parseReportTaskPeriod } from './reportTaskPeriod.js';

// «Сегодня» фиксировано: без этого тест жил бы ровно до следующего месяца.
const NOW = new Date(2026, 8, 12, 15, 30, 0); // 12 сентября 2026, пятница

const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const range = (task: string) => {
  const p = parseReportTaskPeriod(task, NOW);
  return p ? { from: day(p.startMs), to: day(p.endMs), label: p.label } : null;
};

describe('parseReportTaskPeriod', () => {
  it('название месяца — весь месяц текущего года', () => {
    expect(range('покажи двигатели за сентябрь')).toEqual({ from: '2026-09-01', to: '2026-09-30', label: 'сентябрь 2026' });
    expect(range('отчёт по нарядам в августе')).toEqual({ from: '2026-08-01', to: '2026-08-31', label: 'август 2026' });
  });

  it('месяц с годом берёт указанный год, а не текущий', () => {
    expect(range('двигатели за март 2025')).toEqual({ from: '2025-03-01', to: '2025-03-31', label: 'март 2025' });
  });

  it('прошлый и текущий месяц считаются от сегодня', () => {
    expect(range('что было за прошлый месяц')).toEqual({ from: '2026-08-01', to: '2026-08-31', label: 'август 2026' });
    expect(range('сводка за текущий месяц')?.from).toBe('2026-09-01');
  });

  it('годы', () => {
    expect(range('итоги за прошлый год')).toEqual({ from: '2025-01-01', to: '2025-12-31', label: '2025 год' });
    expect(range('итоги за 2024')).toEqual({ from: '2024-01-01', to: '2024-12-31', label: '2024 год' });
  });

  it('явный диапазон датами', () => {
    expect(range('с 01.09.2026 по 15.09.2026')).toEqual({ from: '2026-09-01', to: '2026-09-15', label: '01.09.2026 — 15.09.2026' });
    // Перевёрнутый диапазон не принимаем: «с 15 по 1» — это опечатка, а не отбор.
    expect(range('с 15.09.2026 по 01.09.2026')).toBeNull();
  });

  it('диапазон днями внутри одного месяца', () => {
    expect(range('с 1 по 15 сентября')).toEqual({ from: '2026-09-01', to: '2026-09-15', label: '01.09.2026 — 15.09.2026' });
  });

  it('относительные окна', () => {
    expect(range('за последние 30 дней')).toEqual({ from: '2026-08-14', to: '2026-09-12', label: 'последние 30 дн.' });
    expect(range('за 2 недели')?.from).toBe('2026-08-30');
    expect(range('за неделю')).toEqual({ from: '2026-09-06', to: '2026-09-12', label: 'последние 7 дн.' });
    expect(range('за сегодня')).toEqual({ from: '2026-09-12', to: '2026-09-12', label: '12.09.2026' });
    expect(range('за вчера')?.from).toBe('2026-09-11');
  });

  it('день включается целиком — иначе отчёт терял бы последние сутки', () => {
    const p = parseReportTaskPeriod('за сегодня', NOW)!;
    expect(new Date(p.endMs).getHours()).toBe(23);
    expect(new Date(p.endMs).getMinutes()).toBe(59);
  });

  it('без упоминания времени период не выдумывается', () => {
    expect(parseReportTaskPeriod('покажи отчёт по двигателям', NOW)).toBeNull();
    expect(parseReportTaskPeriod('', NOW)).toBeNull();
  });

  it('номер детали не превращается в год', () => {
    expect(parseReportTaskPeriod('найди деталь 3301-15-30', NOW)).toBeNull();
  });

  it('буква «ё» не мешает разбору', () => {
    expect(range('за трёх последние 5 дней')?.to).toBe('2026-09-12');
  });
});
