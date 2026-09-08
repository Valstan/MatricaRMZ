import { describe, expect, it } from 'vitest';

import {
  REPAIR_HISTORY_ACTIONS,
  buildRepairHistoryMeta,
  currentWorkshopFromHistory,
  parseRepairHistoryMeta,
  repairHistoryActionOptions,
  repairHistoryFromOperations,
  repairHistoryMetaForStatus,
  repairHistoryNoteLine,
  type RepairHistorySourceRow,
} from './engineRepairHistory.js';

// История ремонта (просьба владельца 08.09.2026) живёт в строках operations: они уже
// синхронизируются, закрыты правами и попадают в аудит.
const row = (over: Partial<RepairHistorySourceRow>): RepairHistorySourceRow => ({
  id: 'op1',
  operationType: 'repair_history_entry',
  note: null,
  performedAt: null,
  performedBy: null,
  metaJson: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('разбор и сборка записи истории', () => {
  it('строит и читает запись со всеми полями', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Перемещение в другой цех',
      workshopId: 'W2',
      reason: 'нужен стенд',
      note: 'договорились с мастером',
      extra: [{ label: 'Бригада', value: '3' }],
    });
    const parsed = parseRepairHistoryMeta(JSON.stringify(meta));
    expect(parsed?.action).toBe('Перемещение в другой цех');
    expect(parsed?.workshopId).toBe('W2');
    expect(parsed?.reason).toBe('нужен стенд');
    expect(parsed?.extra).toEqual([{ label: 'Бригада', value: '3' }]);
  });

  it('чужой meta_json записью истории не считается', () => {
    expect(parseRepairHistoryMeta(JSON.stringify({ kind: 'repair_checklist', action: 'x' }))).toBeNull();
    expect(parseRepairHistoryMeta('{битый json')).toBeNull();
    expect(parseRepairHistoryMeta(null)).toBeNull();
  });

  it('запись без действия недействительна: строка истории без действия ничего не сообщает', () => {
    expect(parseRepairHistoryMeta(JSON.stringify({ kind: 'repair_history', action: '   ' }))).toBeNull();
  });

  it('пустые произвольные поля отбрасываются, а не сохраняются мусором', () => {
    const meta = buildRepairHistoryMeta({ action: 'Ремонт закончен', extra: [{ label: '', value: '' }] });
    expect(meta.extra).toBeUndefined();
  });
});

describe('лента истории', () => {
  const rows: RepairHistorySourceRow[] = [
    row({
      id: 'a',
      performedAt: 300,
      metaJson: JSON.stringify(buildRepairHistoryMeta({ action: 'Ремонт закончен', auto: true })),
    }),
    row({
      id: 'b',
      performedAt: 200,
      metaJson: JSON.stringify(buildRepairHistoryMeta({ action: 'Своё действие', workshopId: 'W1', reason: 'по просьбе' })),
    }),
    // Межцеховые передачи писала карточка задолго до этой вкладки — они обязаны быть в ленте.
    row({
      id: 'c',
      operationType: 'workshop_transfer',
      performedAt: 100,
      note: 'Цех: Разборка → Сборка',
      metaJson: JSON.stringify({ fromWorkshopId: 'W0', toWorkshopId: 'W1' }),
    }),
    row({ id: 'skip', operationType: 'engine_inventory', performedAt: 400, metaJson: JSON.stringify({ kind: 'repair_checklist' }) }),
  ];

  it('новые события сверху, посторонние строки не попадают', () => {
    const list = repairHistoryFromOperations(rows);
    expect(list.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('различает автоматические и ручные записи', () => {
    const byId = new Map(repairHistoryFromOperations(rows).map((e) => [e.id, e]));
    expect(byId.get('a')?.source).toBe('auto');
    expect(byId.get('b')?.source).toBe('manual');
    // Передача цеха — тоже событие программы, править его вручную нельзя.
    expect(byId.get('c')?.source).toBe('auto');
  });

  it('передача цеха разбирается в действие и целевой цех', () => {
    const entry = repairHistoryFromOperations(rows).find((e) => e.id === 'c');
    expect(entry?.action).toBe('Перемещение в другой цех');
    expect(entry?.workshopId).toBe('W1');
  });

  it('без времени события берётся время изменения строки', () => {
    const list = repairHistoryFromOperations([row({ id: 'x', performedAt: null, updatedAt: 777, metaJson: JSON.stringify(buildRepairHistoryMeta({ action: 'Что-то' })) })]);
    expect(list[0]?.at).toBe(777);
  });
});

describe('подсказки и текущий цех', () => {
  it('подсказки — предустановленные плюс введённые операторами', () => {
    const entries = repairHistoryFromOperations([
      row({ id: 'b', metaJson: JSON.stringify(buildRepairHistoryMeta({ action: 'Ушёл на балансировку' })) }),
    ]);
    const options = repairHistoryActionOptions(entries);
    expect(options).toContain('Ушёл на балансировку');
    for (const preset of REPAIR_HISTORY_ACTIONS) expect(options).toContain(preset);
    expect(new Set(options).size).toBe(options.length);
  });

  it('текущий цех — последнее событие, где цех назван', () => {
    const entries = repairHistoryFromOperations([
      row({ id: 'new', performedAt: 300, metaJson: JSON.stringify(buildRepairHistoryMeta({ action: 'Замечание ОТК' })) }),
      row({ id: 'old', performedAt: 200, metaJson: JSON.stringify(buildRepairHistoryMeta({ action: 'Перемещение в другой цех', workshopId: 'W5' })) }),
    ]);
    expect(currentWorkshopFromHistory(entries)).toBe('W5');
    expect(currentWorkshopFromHistory([])).toBeNull();
  });
});

describe('связь со стадиями и лентой паспорта', () => {
  it('автозапись стадии берёт подпись из общего реестра статусов', () => {
    const meta = repairHistoryMetaForStatus('status_repaired');
    expect(meta.action).toBe('Отремонтирован');
    expect(meta.auto).toBe(true);
  });

  it('короткая строка события читается человеком', () => {
    const meta = buildRepairHistoryMeta({ action: 'Перемещение в другой цех', workshopId: 'W2', reason: 'нужен стенд' });
    expect(repairHistoryNoteLine(meta, 'Цех сборки')).toBe('Перемещение в другой цех · цех: Цех сборки · причина: нужен стенд');
  });
});
