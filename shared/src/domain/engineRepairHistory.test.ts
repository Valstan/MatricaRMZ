import { describe, expect, it } from 'vitest';

import {
  REPAIR_HISTORY_ACTIONS,
  buildRepairHistoryMeta,
  currentWorkshopFromHistory,
  lastSheetEntry,
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

// Этапы работ (15.09.2026): строка этапа работ — та же запись истории с полем `sheet`;
// классификация `entryType` нужна отчётам и ступеням списка, у старых строк она выводится.
describe('классификация записей и строки этапов работ', () => {
  it('строка этапа работ проходит через meta целиком — поля, узел, тип', () => {
    const meta = buildRepairHistoryMeta({
      action: 'Обкатка',
      at: 500,
      sheet: {
        typeId: 't1',
        typeCode: 'obkatka',
        typeName: 'Обкатка',
        fields: [{ code: 'hours', label: 'Часы', type: 'number', value: 4 }],
      },
    });
    const parsed = parseRepairHistoryMeta(JSON.stringify(meta));
    expect(parsed?.sheet?.typeCode).toBe('obkatka');
    expect(parsed?.sheet?.fields).toEqual([{ code: 'hours', label: 'Часы', type: 'number', value: 4 }]);
    const [entry] = repairHistoryFromOperations([row({ id: 's', metaJson: JSON.stringify(meta) })]);
    expect(entry?.entryType).toBe('sheet');
    expect(entry?.at).toBe(500);
    expect(lastSheetEntry([entry!])?.sheet?.typeName).toBe('Обкатка');
  });

  it('старые строки без entryType классифицируются по признакам', () => {
    const list = repairHistoryFromOperations([
      row({ id: 'auto', performedAt: 3, metaJson: JSON.stringify({ kind: 'repair_history', action: 'Отремонтирован', auto: true }) }),
      row({ id: 'man', performedAt: 2, metaJson: JSON.stringify({ kind: 'repair_history', action: 'Своё' }) }),
      row({ id: 'tr', performedAt: 1, operationType: 'workshop_transfer', metaJson: JSON.stringify({ toWorkshopId: 'W1' }) }),
    ]);
    expect(list.map((e) => e.entryType)).toEqual(['status', 'manual', 'transfer']);
    expect(lastSheetEntry(list)).toBeNull();
  });

  // Справочник цехов живёт на сервере и требует masterdata.view — без снимка читатель без
  // прав видел в колонке «Цех» uuid. Снимок обязан пережить круг build → JSON → parse:
  // парсер режет неизвестные ключи, и поле, положенное только в билдер, пропало бы молча.
  it('имя цеха едет снимком в самой строке и переживает круг сборки и разбора', () => {
    const meta = buildRepairHistoryMeta({ action: 'Обкатка', workshopId: 'W1', workshopName: 'Цех № 4', at: 100 });
    expect(meta.workshopName).toBe('Цех № 4');
    const parsed = parseRepairHistoryMeta(JSON.stringify(meta));
    expect(parsed?.workshopName).toBe('Цех № 4');
    expect(parsed?.workshopId).toBe('W1');
  });

  it('пустое имя цеха в строку не кладётся — нечего показывать, нечего и хранить', () => {
    expect(buildRepairHistoryMeta({ action: 'Обкатка', workshopId: 'W1', workshopName: '   ' }).workshopName).toBeUndefined();
    expect(buildRepairHistoryMeta({ action: 'Обкатка' }).workshopName).toBeUndefined();
  });

  it('автозапись стадии несёт entryType и дату строки, если она дана', () => {
    const meta = repairHistoryMetaForStatus('status_repaired', 777);
    expect(meta.entryType).toBe('status');
    expect(meta.at).toBe(777);
  });
});
