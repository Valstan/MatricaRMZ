import { describe, expect, it } from 'vitest';

import {
  buildEngineHistoryFeed,
  engineHistoryFeedFieldLines,
  type EngineHistoryFeedRow,
} from './engineHistoryFeed.js';

const T = 1_700_000_000_000;
const DAY = 86_400_000;

function row(partial: Partial<EngineHistoryFeedRow> & { id: string }): EngineHistoryFeedRow {
  return {
    operationType: 'repair_history_entry',
    status: 'done',
    note: null,
    performedAt: T,
    performedBy: 'ivanov',
    metaJson: null,
    createdAt: T,
    updatedAt: T,
    ...partial,
  };
}

function repairMeta(meta: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'repair_history', action: 'Что-то', ...meta });
}

describe('единая лента событий по двигателю', () => {
  it('собирает в одну таблицу этап ремонта, этап работ, ручную запись и прочую операцию', () => {
    // Раньше это были три отдельные ленты на одних и тех же данных.
    const feed = buildEngineHistoryFeed([
      row({
        id: 'op1',
        operationType: 'work_order',
        performedAt: T - 4 * DAY,
        performedBy: 'petrov',
        note: 'наряд на разборку',
      }),
      row({ id: 'op2', performedAt: T - 3 * DAY, metaJson: repairMeta({ entryType: 'manual', action: 'Позвонил заказчик', reason: 'сроки' }) }),
      row({
        id: 'op3',
        performedAt: T - 2 * DAY,
        metaJson: repairMeta({
          entryType: 'sheet',
          action: 'Обкатка',
          sheet: { typeId: 't1', typeCode: 'obkatka', typeName: 'Обкатка', fields: [{ code: 'hours', label: 'Часы обкатки', type: 'number', value: 12 }] },
        }),
      }),
      row({
        id: 'op4',
        performedAt: T - DAY,
        metaJson: repairMeta({
          entryType: 'stage',
          action: 'Сборка',
          stage: { code: 'sborka', name: 'Сборка' },
          at: T - DAY,
        }),
      }),
    ]);
    expect(feed.map((i) => i.kind)).toEqual(['stage', 'sheet', 'manual', 'operation']);
    expect(feed.map((i) => i.title)).toEqual(['Сборка', 'Обкатка', 'Позвонил заказчик', 'Наряд']);
    expect(feed.map((i) => i.kindLabel)).toEqual([
      'Этап ремонта',
      'Этап работ',
      'Ручная запись',
      'Операция',
    ]);
  });

  it('дата события и дата записи — разные колонки', () => {
    // Владелец просил видеть и реальную дату этапа, и когда его ввели: этап «Сборка» за
    // 20-е может быть введён сегодня, и без второй даты он выглядит свежим событием.
    const feed = buildEngineHistoryFeed([
      row({
        id: 'op1',
        performedAt: T,
        updatedAt: T,
        metaJson: repairMeta({ entryType: 'stage', action: 'Сборка', stage: { code: 'sborka', name: 'Сборка' }, at: T - 5 * DAY }),
      }),
    ]);
    expect(feed[0].at).toBe(T - 5 * DAY);
    expect(feed[0].recordedAt).toBe(T);
  });

  it('введённая оператором дата события важнее момента записи', () => {
    const feed = buildEngineHistoryFeed([
      row({ id: 'op1', performedAt: T, metaJson: repairMeta({ entryType: 'manual', action: 'Возврат из цеха', at: T - 9 * DAY }) }),
    ]);
    expect(feed[0].at).toBe(T - 9 * DAY);
  });

  it('сортировка сверху вниз по дате события; бездаты — в конец', () => {
    const feed = buildEngineHistoryFeed([
      row({ id: 'old', performedAt: T - 5 * DAY }),
      row({ id: 'new', performedAt: T - DAY }),
      // Даты нет: у операции её не оказалось — «неизвестно когда», а не «самое свежее».
      row({ id: 'undated', performedAt: null, updatedAt: T - 10 * DAY, operationType: 'tool_movement' }),
    ]);
    expect(feed.map((i) => i.id)).toEqual(['new', 'old', 'undated']);
  });

  it('автор служебного скрипта назван словами, человека — логином', () => {
    const feed = buildEngineHistoryFeed([
      row({ id: 'op1', performedBy: 'stages:backfill' }),
      row({ id: 'op2', performedBy: 'ivanov' }),
      row({ id: 'op3', performedBy: 'local' }),
    ]);
    expect(feed.find((i) => i.id === 'op1')?.by).toBe('перенос этапов из прежних отметок (программа)');
    expect(feed.find((i) => i.id === 'op2')?.by).toBe('ivanov');
    // `local` — клиент без входа в сеть, автора нет: ячейка пустая, а не врёт.
    expect(feed.find((i) => i.id === 'op3')?.by).toBe('');
  });

  it('этап ремонта правится в ленте, строка этапа работ — только переходом', () => {
    const feed = buildEngineHistoryFeed([
      row({ id: 'stage1', metaJson: repairMeta({ entryType: 'stage', action: 'Сборка', stage: { code: 'sborka', name: 'Сборка' } }) }),
      row({
        id: 'sheet1',
        metaJson: repairMeta({ entryType: 'sheet', action: 'Вал', sheet: { typeId: 't', typeCode: 'val', typeName: 'Вал', fields: [] } }),
      }),
    ]);
    expect(feed.find((i) => i.id === 'stage1')?.editable).toBe(true);
    expect(feed.find((i) => i.id === 'stage1')?.sheetRowId).toBeNull();
    expect(feed.find((i) => i.id === 'sheet1')?.editable).toBe(false);
    expect(feed.find((i) => i.id === 'sheet1')?.sheetRowId).toBe('sheet1');
  });

  it('повторный проход этапа виден в строке, а не теряется', () => {
    const feed = buildEngineHistoryFeed([
      row({
        id: 'stage1',
        metaJson: repairMeta({ entryType: 'stage', action: 'Сборка', stage: { code: 'sborka', name: 'Сборка' }, repeat: { pass: 2, reason: 'вернули из ОТК' } }),
      }),
    ]);
    expect(feed[0].pass).toBe(2);
  });

  it('цех, причина и примечание строки не теряются при сборке', () => {
    const feed = buildEngineHistoryFeed([
      row({
        id: 'op1',
        metaJson: repairMeta({
          entryType: 'manual',
          action: 'Перемещение в другой цех',
          workshopId: 'w1',
          workshopName: 'Разборка',
          reason: 'ждёт детали',
          note: 'позвонить в снабжение',
          extra: [{ label: 'Мастер', value: 'Иванов' }],
        }),
      }),
    ]);
    expect(feed[0].workshopId).toBe('w1');
    expect(feed[0].workshopName).toBe('Разборка');
    expect(feed[0].reason).toBe('ждёт детали');
    expect(feed[0].note).toBe('позвонить в снабжение');
    expect(feed[0].extra).toEqual([{ label: 'Мастер', value: 'Иванов' }]);
  });

  it('поля строки этапа работ читаются как подписи, справочник не нужен', () => {
    const feed = buildEngineHistoryFeed([
      row({
        id: 'sheet1',
        metaJson: repairMeta({
          entryType: 'sheet',
          action: 'Обкатка',
          sheet: {
            typeId: 't',
            typeCode: 'obkatka',
            typeName: 'Обкатка',
            fields: [
              { code: 'hours', label: 'Часы обкатки', type: 'number', value: 12 },
              { code: 'empty', label: 'Пустое', type: 'text', value: null },
            ],
          },
        }),
      }),
    ]);
    // Пустое поле в примечание не попадает — колонка и так перегружена.
    expect(engineHistoryFeedFieldLines(feed[0])).toEqual(['Часы обкатки: 12']);
  });

  it('операция несёт свой статус, а строка истории — нет', () => {
    const feed = buildEngineHistoryFeed([
      row({ id: 'op1', operationType: 'work_order', status: 'in_repair' }),
      row({ id: 'op2', status: 'done', metaJson: repairMeta({ entryType: 'manual', action: 'Запись' }) }),
    ]);
    expect(feed.find((i) => i.id === 'op1')?.statusLabel).toBe('В ремонте');
    expect(feed.find((i) => i.id === 'op2')?.statusLabel).toBe('');
  });

  it('неизвестный тип операции показывается своим кодом, а не теряется', () => {
    // Реестр подписей неполон и всегда будет неполным: новый тип операции не должен
    // молча исчезнуть из ленты — иначе по карточке нельзя понять, что двигатель трогали.
    const feed = buildEngineHistoryFeed([row({ id: 'x', operationType: 'brand_new_kind', note: 'что-то' })]);
    expect(feed).toHaveLength(1);
    expect(feed[0].title).toBe('brand_new_kind');
    expect(feed[0].kindLabel).toBe('Операция');
  });

  it('межцеховая передача видна как переезд даже без meta', () => {
    // Так пишут переезды старые строки — без них лента начиналась бы с пустого места.
    const feed = buildEngineHistoryFeed([
      row({ id: 'tr1', operationType: 'workshop_transfer', metaJson: JSON.stringify({ toWorkshopId: 'w2' }) }),
    ]);
    expect(feed[0].kind).toBe('operation');
    expect(feed[0].title).toBe('Межцеховая передача');
    expect(feed[0].workshopId).toBe('w2');
  });
});