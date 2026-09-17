import { describe, expect, it } from 'vitest';

import { ENGINE_INVENTORY_STAGE } from '@matricarmz/shared';

import { computeEngineInventoryFlags } from './engineService.js';

// 17.09.2026: у этапа «Комплектовка сделана» появилась ДАТА. Кнопка «Провести комплектность»
// пишет сегодняшнее число в поле «Дата осмотра (акт комплектности)» того же листа
// (stage=engine_inventory), main читает его отсюда в `completenessActDate` строки списка, а домен
// `engineFactoryStage` датирует этим числом этап. Ошибка в разборе значения не падает, а тихо
// подставляет в отчёт «01.01.1970» или прочерк — поэтому разбор закрыт тестом.
//
// Второе, что держит этот файл: «акт начали заполнять» (actStarted, от галочек «на месте») и
// «осмотр проведён» (дата) — РАЗНЫЕ вопросы об одном листе. Их легко склеить при следующей
// правке, и тогда либо у двигателей без галочек пропадёт дата, либо дата появится у тех, кого
// никто не осматривал.
//
// Флаги считаются по `meta_json` последнего листа, то есть по данным, приехавшим с сервера от
// разных версий клиента: значения приходят и числами, и строками, и отсутствуют вовсе. Поэтому
// половина проверок ниже — про мусор.

/** Лист ровно той формы, что лежит в `operations.meta_json` (RepairChecklistPayload). */
function sheet(answers: Record<string, unknown>): unknown {
  return {
    kind: 'repair_checklist',
    templateId: 'tpl-engine-inventory',
    templateVersion: 1,
    stage: ENGINE_INVENTORY_STAGE,
    engineEntityId: 'engine-1',
    filledBy: null,
    filledAt: null,
    answers,
  };
}

/** Ответ-таблица «список деталей» — единственный источник флагов акта. */
function table(...list: unknown[]): Record<string, unknown> {
  return { engine_inventory_items: { kind: 'table', rows: list } };
}

/** Ответ-дата «Дата осмотра (акт комплектности)» — то, что ставит «Провести комплектность». */
function inspection(value: unknown): Record<string, unknown> {
  return { completeness_inspection_date: { kind: 'date', value } };
}

const EMPTY = { crankcaseScrapped: false, actStarted: false, defectStarted: false, completenessInspectionAt: null };
const INSPECTED_AT = Date.UTC(2026, 6, 15);

describe('computeEngineInventoryFlags — дата осмотра', () => {
  it('дата осмотра доезжает до флагов как есть — ею датируется этап «Комплектовка сделана»', () => {
    const flags = computeEngineInventoryFlags(sheet(inspection(INSPECTED_AT)));
    expect(flags.completenessInspectionAt, 'дата этапа берётся отсюда; сдвиг значения сдвинет этап в отчёте').toBe(INSPECTED_AT);
  });

  it('проведённая комплектность датирует этап сама по себе — галочки «на месте» для этого не нужны', () => {
    // Акт можно провести и тогда, когда комиссия не нашла ни одной детали: лист пуст, а осмотр был.
    const flags = computeEngineInventoryFlags(sheet(inspection(INSPECTED_AT)));
    expect(flags.completenessInspectionAt).toBe(INSPECTED_AT);
    expect(flags.actStarted, 'дата не должна зажигать признак «акт заполняют» — это разные вопросы').toBe(false);
  });

  it('галочки «на месте» без даты: акт заполняют, но осмотр не проведён', () => {
    // Обратная сторона того же различения: до 17.09.2026 у этапа не было даты вовсе, и признак
    // заполнения был единственным сигналом. Если склеить их обратно, дата появится у всех, кто
    // просто отметил деталь на месте.
    const flags = computeEngineInventoryFlags(sheet(table({ part_name: 'Коленчатый вал', present: true })));
    expect(flags.actStarted).toBe(true);
    expect(flags.completenessInspectionAt, 'дату ставит только проводка комплектности, а не заполнение списка деталей').toBe(null);
  });

  it('мусор вместо даты — «даты нет», а не 01.01.1970 в колонке «Дата этапа»', () => {
    const garbage: Array<[string, unknown]> = [
      ['дата строкой с бумаги, а не unix-временем', { kind: 'date', value: '15.07.2026' }],
      ['ISO-строка вместо миллисекунд', { kind: 'date', value: '2026-07-15' }],
      ['ноль — это «поле пустое», а не полночь 1970-го', { kind: 'date', value: 0 }],
      ['отрицательное время осмотра не бывает', { kind: 'date', value: -1 }],
      ['NaN после чужого арифметического промаха', { kind: 'date', value: Number.NaN }],
      ['поле есть, но пустое', { kind: 'date', value: null }],
      ['ответ без kind — форма из другой версии клиента', { value: INSPECTED_AT }],
      ['то же число, но лежит в текстовом ответе', { kind: 'text', value: INSPECTED_AT }],
      ['ответ вообще не объект', 'сегодня'],
    ];
    for (const [why, answer] of garbage) {
      const flags = computeEngineInventoryFlags(sheet({ completeness_inspection_date: answer }));
      expect(flags.completenessInspectionAt, why).toBe(null);
    }
  });

  it('листа без поля даты достаточно: у старых актов её просто нет', () => {
    // Поле `completeness_inspection_date` есть не в каждом шаблоне (серверный дефолт его не знал),
    // поэтому «ключа нет» — норма, а не повод выдать чужое значение.
    const flags = computeEngineInventoryFlags(sheet(table({ part_name: 'Картер блока', present: true })));
    expect(flags.completenessInspectionAt).toBe(null);
  });
});

describe('computeEngineInventoryFlags — прежние флаги акта', () => {
  it('actStarted: акт заполняют, как только хоть одна деталь отмечена «на месте»', () => {
    // Галка приезжает от разных версий клиента и числом, и строкой — все написания значат одно.
    for (const present of [true, 'true', 1, '1']) {
      expect(computeEngineInventoryFlags(sheet(table({ part_name: 'Коленвал', present }))).actStarted, `«на месте» в виде ${JSON.stringify(present)}`).toBe(true);
    }
    for (const present of [false, 'false', 0, '', null, undefined]) {
      expect(computeEngineInventoryFlags(sheet(table({ part_name: 'Коленвал', present }))).actStarted, `пустая галка в виде ${JSON.stringify(present)} не считается заполнением`).toBe(false);
    }
  });

  it('defectStarted: вердикт о детали — это утиль или замена, «на месте» дефектовкой не считается', () => {
    const byScrap = computeEngineInventoryFlags(sheet(table({ part_name: 'Вкладыш', scrap_qty: 1 })));
    const byReplace = computeEngineInventoryFlags(sheet(table({ part_name: 'Вкладыш', replace_qty: '2' })));
    expect(byScrap.defectStarted).toBe(true);
    expect(byReplace.defectStarted, 'количество строкой приходит из синка — это тот же вердикт').toBe(true);

    const onlyPresent = computeEngineInventoryFlags(sheet(table({ part_name: 'Вкладыш', present: true })));
    expect(onlyPresent.actStarted).toBe(true);
    expect(onlyPresent.defectStarted, 'приёмка — ещё не дефектовка: иначе этап прыгнет вперёд от одной галки').toBe(false);

    const zeros = computeEngineInventoryFlags(sheet(table({ part_name: 'Вкладыш', scrap_qty: 0, replace_qty: 0 })));
    expect(zeros.defectStarted).toBe(false);
    const negative = computeEngineInventoryFlags(sheet(table({ part_name: 'Вкладыш', scrap_qty: -3 })));
    expect(negative.defectStarted, 'отрицательное количество — мусор, а не вердикт о детали').toBe(false);
  });

  it('crankcaseScrapped: авто-брак даёт только картер и только в утиле', () => {
    const scrapped = computeEngineInventoryFlags(sheet(table({ part_name: 'Картер блока цилиндров', scrap_qty: 1 })));
    expect(scrapped.crankcaseScrapped, 'картер узнаётся по вхождению «картер» в имя, регистр не важен').toBe(true);

    const other = computeEngineInventoryFlags(sheet(table({ part_name: 'Коленчатый вал', scrap_qty: 5 })));
    expect(other.crankcaseScrapped, 'прочие детали в утиле двигатель не бракуют (PENDING §D)').toBe(false);
    expect(other.defectStarted).toBe(true);

    const replaced = computeEngineInventoryFlags(sheet(table({ part_name: 'КАРТЕР', replace_qty: 1 })));
    expect(replaced.crankcaseScrapped, 'картер заказали новый — это не утиль двигателя').toBe(false);
    const intact = computeEngineInventoryFlags(sheet(table({ part_name: 'Картер', scrap_qty: 0 })));
    expect(intact.crankcaseScrapped).toBe(false);
  });

  it('перебор строк не обрывается раньше времени: картер найден и в конце длинного списка', () => {
    const flags = computeEngineInventoryFlags(
      sheet({
        ...inspection(INSPECTED_AT),
        ...table(
          { part_name: 'Коленчатый вал', present: true },
          { part_name: 'Вкладыш коренной', replace_qty: 2 },
          null,
          { part_name: 'Картер маховика', scrap_qty: 1 },
        ),
      }),
    );
    expect(flags).toEqual({ crankcaseScrapped: true, actStarted: true, defectStarted: true, completenessInspectionAt: INSPECTED_AT });
  });
});

describe('computeEngineInventoryFlags — битый лист', () => {
  it('нечитаемый meta_json не валит список двигателей, а даёт «ничего не известно»', () => {
    // На вход приходит результат safeJsonParse: у пустого meta_json это пустая СТРОКА, не объект.
    const broken: unknown[] = [
      '',
      'не json',
      null,
      undefined,
      42,
      {},
      { answers: null },
      { answers: 'сломано' },
      sheet({}),
      sheet({ engine_inventory_items: { kind: 'text', value: '' } }),
      sheet({ engine_inventory_items: { kind: 'table', rows: 'нет строк' } }),
      sheet(table('строка не объект', null, undefined)),
    ];
    for (const payload of broken) {
      expect(computeEngineInventoryFlags(payload), `битый лист ${JSON.stringify(payload) ?? String(payload)} должен молча дать пустые флаги`).toEqual(EMPTY);
    }
  });
});
