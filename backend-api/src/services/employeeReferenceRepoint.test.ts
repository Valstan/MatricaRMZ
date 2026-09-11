import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { __testables, deepReplaceId, repointAttributeValue, repointOperationMeta } from './employeeReferenceRepoint.js';

const { mergePersonEntries, dedupeEmployeeLists, operationStoreLabel } = __testables;

// Перевод ссылок правит ЖИВЫЕ данные и необратим. Самое дорогое здесь — не «заменился ли id»,
// а что происходит, когда основная запись УЖЕ стоит рядом со вторичной: в той же бригаде, в том
// же списке сотрудников акта. Эти случаи и проверяются вызовами.
const LOSER = 'aaaaaaaa-0000-0000-0000-000000000002';
const SURVIVOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER = 'bbbbbbbb-0000-0000-0000-000000000009';

describe('замена id в JSON', () => {
  it('меняет значения на любой глубине и не трогает чужие', () => {
    const { value, changed } = deepReplaceId(
      { a: LOSER, b: [{ c: LOSER }, OTHER], d: 'текст', e: 42 },
      LOSER,
      SURVIVOR,
    );
    expect(changed).toBe(true);
    expect(value).toEqual({ a: SURVIVOR, b: [{ c: SURVIVOR }, OTHER], d: 'текст', e: 42 });
  });

  it('id в КЛЮЧЕ тоже ссылка: карты «по сотруднику» иначе остались бы на погашенной записи', () => {
    const { value, changed } = deepReplaceId({ [LOSER]: { hours: 8 } }, LOSER, SURVIVOR);
    expect(changed).toBe(true);
    expect(value).toEqual({ [SURVIVOR]: { hours: 8 } });
  });

  it('без вхождений ничего не меняет', () => {
    expect(deepReplaceId({ a: OTHER }, LOSER, SURVIVOR).changed).toBe(false);
  });
});

describe('бригада и выплаты наряда', () => {
  it('обе записи в одной бригаде — один человек: КТУ и выплаты складываются', () => {
    const res = mergePersonEntries(
      [
        { employeeId: SURVIVOR, employeeName: 'Иванова М. П.', ktu: 1, payoutRub: 1000 },
        { employeeId: LOSER, employeeName: 'Иванова М. П.', ktu: 0.5, payoutRub: 500 },
      ],
      LOSER,
      SURVIVOR,
    );
    expect(res.merged).toBe(1);
    expect(res.rows).toEqual([{ employeeId: SURVIVOR, employeeName: 'Иванова М. П.', ktu: 1.5, payoutRub: 1500 }]);
  });

  it('замороженная выплата остаётся замороженной', () => {
    const res = mergePersonEntries(
      [
        { employeeId: SURVIVOR, ktu: 1 },
        { employeeId: LOSER, ktu: 1, payoutFrozen: true },
      ],
      LOSER,
      SURVIVOR,
    );
    expect((res.rows as Array<Record<string, unknown>>)[0]?.payoutFrozen).toBe(true);
  });

  it('вторичная запись одна в бригаде — просто переезжает, ничего не складывая', () => {
    const res = mergePersonEntries([{ employeeId: LOSER, ktu: 1 }], LOSER, SURVIVOR);
    expect(res.merged).toBe(0);
    expect(res.rows).toEqual([{ employeeId: SURVIVOR, ktu: 1 }]);
  });

  it('чужих членов бригады не касается', () => {
    const res = mergePersonEntries([{ employeeId: OTHER, ktu: 2 }], LOSER, SURVIVOR);
    expect(res.changed).toBe(false);
    expect(res.rows).toEqual([{ employeeId: OTHER, ktu: 2 }]);
  });
});

describe('списки сотрудников актов', () => {
  it('один человек дважды в одном списке — дубль, снимается', () => {
    const { value, removed } = dedupeEmployeeLists(
      { answers: { a1: { kind: 'employees', employees: [{ employeeId: SURVIVOR }, { employeeId: SURVIVOR }, { employeeId: OTHER }] } } },
      SURVIVOR,
    );
    expect(removed).toBe(1);
    expect(value).toEqual({ answers: { a1: { kind: 'employees', employees: [{ employeeId: SURVIVOR }, { employeeId: OTHER }] } } });
  });

  it('комиссию и подписи не чистит: там один человек законно стоит в двух ролях', () => {
    const meta = { commission: [{ employeeId: SURVIVOR, caption: 'Начальник цеха' }, { employeeId: SURVIVOR, caption: 'Мастер цеха' }] };
    expect(dedupeEmployeeLists(meta, SURVIVOR).removed).toBe(0);
  });
});

describe('перевод meta_json операции', () => {
  it('наряд: бригада, подписи и утверждающий в грифе — за один проход', () => {
    const meta = JSON.stringify({
      crew: [{ employeeId: LOSER, ktu: 1 }],
      payouts: [{ employeeId: LOSER, amountRub: 700 }],
      signatureBlocks: [{ blockId: 'issue', slots: [{ caption: 'Наряд выдал', employeeId: LOSER }] }],
      printSettings: { approverEmployeeId: LOSER },
    });
    const res = repointOperationMeta({ operationType: 'work_order', metaJson: meta, fromId: LOSER, toId: SURVIVOR });
    expect(res.changed).toBe(true);
    expect(res.unparsable).toBe(false);
    expect(res.metaJson).not.toContain(LOSER);
    const parsed = JSON.parse(String(res.metaJson));
    expect(parsed.crew[0].employeeId).toBe(SURVIVOR);
    expect(parsed.signatureBlocks[0].slots[0].employeeId).toBe(SURVIVOR);
    expect(parsed.printSettings.approverEmployeeId).toBe(SURVIVOR);
  });

  it('акт двигателя: списки сотрудников чистятся от возникшего дубля', () => {
    const meta = JSON.stringify({
      answers: { who: { kind: 'employees', employees: [{ employeeId: SURVIVOR }, { employeeId: LOSER }] } },
    });
    const res = repointOperationMeta({ operationType: 'completeness', metaJson: meta, fromId: LOSER, toId: SURVIVOR });
    expect(res.duplicatesRemoved).toBe(1);
    expect(JSON.parse(String(res.metaJson)).answers.who.employees).toEqual([{ employeeId: SURVIVOR }]);
  });

  it('перемещение инструмента переводится общей заменой, без своей ветки', () => {
    const meta = JSON.stringify({ employeeId: LOSER, confirmedById: LOSER, confirmed: true });
    const res = repointOperationMeta({ operationType: 'tool_movement', metaJson: meta, fromId: LOSER, toId: SURVIVOR });
    expect(JSON.parse(String(res.metaJson))).toEqual({ employeeId: SURVIVOR, confirmedById: SURVIVOR, confirmed: true });
  });

  it('нечитаемый meta_json не переписывается молча, а помечается', () => {
    const res = repointOperationMeta({ operationType: 'work_order', metaJson: '{битый', fromId: LOSER, toId: SURVIVOR });
    expect(res.unparsable).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.metaJson).toBe('{битый');
  });

  it('без упоминания вторичной записи операция не трогается', () => {
    const meta = JSON.stringify({ crew: [{ employeeId: OTHER, ktu: 1 }] });
    expect(repointOperationMeta({ operationType: 'work_order', metaJson: meta, fromId: LOSER, toId: SURVIVOR }).changed).toBe(false);
  });
});

describe('EAV-значение', () => {
  it('одиночная ссылка переезжает', () => {
    expect(repointAttributeValue(LOSER, LOSER, SURVIVOR)).toEqual({ value: SURVIVOR, changed: true });
  });

  it('в массивной ссылке после замены не остаётся дублей', () => {
    expect(repointAttributeValue([SURVIVOR, LOSER, OTHER], LOSER, SURVIVOR)).toEqual({
      value: [SURVIVOR, OTHER],
      changed: true,
    });
  });

  it('резерв двигателя — обычный JSON-атрибут, переводится тем же путём', () => {
    const res = repointAttributeValue({ holderUserId: LOSER, expiresAt: 123 }, LOSER, SURVIVOR);
    expect(res.value).toEqual({ holderUserId: SURVIVOR, expiresAt: 123 });
  });
});

describe('подписи видов данных', () => {
  it('наряды и заявки названы как в гейте удаления', () => {
    expect(operationStoreLabel('work_order')).toBe('Наряды');
    expect(operationStoreLabel('supply_request')).toBe('Заявки снабжения');
  });

  it('неизвестный код не показывается оператору как есть', () => {
    // Эхо кода — ровно то, из-за чего оператору показывали `engine_inventory` (humanLabels).
    expect(operationStoreLabel('nosuchtype')).not.toBe('nosuchtype');
  });
});

describe('сторож по коду', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./employeeReferenceRepoint.ts', import.meta.url)), 'utf8');

  it('в перевод не попадает таблица, которой нет ни на одной базе', () => {
    // `service_price_orders` описана в схеме, но её не создаёт ни одна миграция: на проде (94 из 94
    // применены) её нет вовсе, и запрос к ней ронял бы весь перевод — вместе с «Проверить» (#865).
    expect(SRC).not.toContain('servicePriceOrders');
  });
});
